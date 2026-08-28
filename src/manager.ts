// Session manager: per-account MyChartClient lifecycle with Postgres-backed
// session storage and the full silent-login ladder (passkey -> password+TOTP
// -> password + email 2FA via Gmail).
import { MyChartClient } from "../../openrecord/npm-package/src/client";
import type { MyChartRequest } from "../../openrecord/scrapers/myChart/core/myChartRequest";
import { MyChartRequest as MyChartRequestClass } from "../../openrecord/scrapers/myChart/core/myChartRequest";
import { myChartUserPassLogin, areCookiesValid, complete2faFlow } from "../../openrecord/scrapers/myChart/auth/login";
import { deserializeCredential, serializeCredential } from "../../openrecord/scrapers/myChart/auth/softwareAuthenticator";
import postgres from "postgres";
import { accountKey, databaseUrl, type InstanceConfig } from "./config";
import { fetchTwoFaCode } from "./gmail";

const sql = postgres(databaseUrl(), { max: 3, idle_timeout: 20 });

export async function ensureSchema(): Promise<void> {
  await sql`create table if not exists bridge_sessions (
    account text primary key,
    serialized text not null,
    passkey text,
    updated_at timestamptz not null default now()
  )`;
}

interface SessionRow { serialized: string; passkey: string | null }

async function loadRow(account: string): Promise<SessionRow | null> {
  const rows = await sql`select serialized, passkey from bridge_sessions where account = ${account} limit 1`;
  if (rows.length === 0) return null;
  return rows[0] as SessionRow;
}

async function saveRow(account: string, serialized: string, passkey: string | null): Promise<void> {
  await sql`
    insert into bridge_sessions (account, serialized, passkey, updated_at)
    values (${account}, ${serialized}, ${passkey}, now())
    on conflict (account) do update set serialized = ${serialized}, passkey = ${passkey}, updated_at = now()
  `;
}

// In-memory client cache keyed by account. Keepalive OFF: sessions are
// revalidated on demand instead of pinged every 30s.
const clients = new Map<string, MyChartClient>();

function normalizePasskey(pk: unknown): { credentialId: string; privateKey: string; rpId: string; userHandle: string; signCount: number } | null {
  if (!pk || typeof pk !== "object") return null;
  const o = pk as Record<string, unknown>;
  if (typeof o.credentialId !== "string" || typeof o.privateKey !== "string") return null;
  return {
    credentialId: o.credentialId,
    privateKey: o.privateKey,
    rpId: typeof o.rpId === "string" ? o.rpId : "",
    userHandle: typeof o.userHandle === "string" ? o.userHandle : "",
    signCount: typeof o.signCount === "number" ? o.signCount : 0,
  };
}

async function persistClient(account: string, client: MyChartClient, inst: InstanceConfig): Promise<void> {
  const serialized = await client.serialize();
  let pkJson: string | null = null;
  if (inst.passkey) pkJson = JSON.stringify(inst.passkey);
  await saveRow(account, serialized, pkJson);
}

/**
 * Force-email SendCode: Providence's 2FA page hides its delivery buttons from
 * the engine's HTML detection, and the engine's blind retry order tries SMS
 * first. This performs the email-forced SendCode ourselves.
 */
async function sendEmailCode(req: MyChartRequest): Promise<boolean> {
  const pageResp = await req.makeRequest({ path: "/Authentication/SecondaryValidation" });
  const page = await pageResp.text();
  const m = page.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/)
    ?? page.match(/__RequestVerificationToken[^"]*["']\s*:\s*["']([^"']+)["']/);
  const token = m?.[1];
  if (!token) return false;
  const res = await req.makeRequest({
    path: "/Authentication/SecondaryValidation/SendCode?noCache=" + Math.random(),
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      __RequestVerificationToken: token,
    },
    body: "deliveryMethodEmail=true&resendCode=false&workflow=1",
    method: "POST",
  });
  const body = await res.text();
  return body.includes('"Success":true');
}

export interface AccountStatus {
  account: string;
  connected: boolean;
  lastLogin?: string;
  method: "passkey" | "totp" | "email" | "none";
}

export async function checkStatus(inst: InstanceConfig): Promise<AccountStatus> {
  const account = accountKey(inst);
  const row = await loadRow(account);
  if (!row) return { account, connected: false, method: inst.passkey ? "passkey" : inst.totpSecret ? "totp" : inst.gmail ? "email" : "none" };
  const req = await MyChartRequestClass.unserialize(row.serialized);
  if (!req) return { account, connected: false, method: "none" };
  const valid = await areCookiesValid(req);
  return { account, connected: valid, lastLogin: new Date().toISOString(), method: inst.passkey ? "passkey" : inst.totpSecret ? "totp" : inst.gmail ? "email" : "none" };
}

/**
 * Return a live client for the account, logging in fully autonomously when
 * needed. Throws with a readable reason if no autonomous path exists.
 */
export async function getClient(inst: InstanceConfig): Promise<MyChartClient> {
  const account = accountKey(inst);

  // 1) in-memory client
  const cached = clients.get(account);
  if (cached && await cached.isSessionValid()) return cached;

  // 2) banked session from DB
  const row = await loadRow(account);
  if (row) {
    const restored = await MyChartClient.fromSerialized(row.serialized, { keepalive: false });
    if (restored && await restored.isSessionValid()) {
      clients.set(account, restored);
      return restored;
    }
  }

  // 3) fresh autonomous login
  if (inst.passkey) {
    // Freshness matters: the WebAuthn signature counter only moves forward.
    // The DB row holds the counter from the most recent successful login;
    // INSTANCES_JSON holds the counter as of initial extraction (stale).
    const dbCred = row?.passkey ? normalizePasskey(JSON.parse(row.passkey)) : null;
    const envCred = normalizePasskey(inst.passkey);
    const base = dbCred ?? envCred;
    if (base) {
      // Sweep the counter forward: portal rejects any counter <= its last-seen
      // value, and we may be several logins behind after process restarts.
      for (let delta = 0; delta <= 15; delta++) {
        const credential = { ...base, signCount: base.signCount + delta };
        try {
          const res = await MyChartClient.connectWithPasskey({
            hostname: inst.hostname, credential, keepalive: false, autoRenew: true,
          });
          if (res.state === "connected") {
            inst.passkey = JSON.parse(serializeCredential(credential));
            await persistClient(account, res.client, inst);
            clients.set(account, res.client);
            console.error(`[${account}] passkey login ok (signCount ${credential.signCount}, delta ${delta})`);
            return res.client;
          }
          if (res.state === "error") break; // network-ish failure: don't sweep
        } catch (e) {
          console.error(`[${account}] passkey attempt delta ${delta} threw:`, String(e).slice(0, 120));
          break;
        }
      }
      console.error(`[${account}] passkey login failed after counter sweep, falling back to password`);
    }
  }
  if (inst.totpSecret) {
    const res = await MyChartClient.connect({
      hostname: inst.hostname, user: inst.username, pass: inst.password,
      totpSecret: inst.totpSecret, keepalive: false, autoRenew: true,
    });
    if (res.state === "connected") {
      await persistClient(account, res.client, inst);
      clients.set(account, res.client);
      return res.client;
    }
    console.error(`[${account}] totp login failed (${res.state})`);
  }

  if (inst.gmail) {
    const since = Date.now();
    // Log in without sending a code (engine would pick SMS first)
    const login = await myChartUserPassLogin({
      hostname: inst.hostname, user: inst.username, pass: inst.password, skipSendCode: true,
    });
    if (login.state === "logged_in") {
      // no 2FA required this time (trust-device cookie) — wrap manually
      const client = await MyChartClient.fromSerialized(await login.mychartRequest.serialize(), { keepalive: false });
      if (client) {
        await persistClient(account, client, inst);
        clients.set(account, client);
        return client;
      }
    }
    if (login.state !== "need_2fa") {
      throw new Error(`[${account}] login failed: ${login.state} ${("error" in login ? login.error : "") ?? ""}`);
    }
    const sent = await sendEmailCode(login.mychartRequest);
    if (!sent) throw new Error(`[${account}] forced email SendCode failed`);
    const code = await fetchTwoFaCode(inst.gmail, since);
    const tfa = await complete2faFlow({ mychartRequest: login.mychartRequest, code, isTOTP: false });
    if (tfa.state !== "logged_in") throw new Error(`[${account}] email 2fa rejected (${tfa.state})`);
    const client = await MyChartClient.fromSerialized(await tfa.mychartRequest.serialize(), { keepalive: false });
    if (!client) throw new Error(`[${account}] session serialize failed after login`);
    await persistClient(account, client, inst);
    clients.set(account, client);
    return client;
  }

  throw new Error(`[${account}] no autonomous login path available (need passkey, totpSecret, or gmail creds)`);
}

/** Manual 2FA completion hook for accounts without an autonomous path. */
export async function completeManual2Fa(inst: InstanceConfig, code: string): Promise<boolean> {
  const account = accountKey(inst);
  const pending = manualPending.get(account);
  if (!pending) throw new Error(`[${account}] no pending 2FA; trigger login first`);
  const tfa = await complete2faFlow({ mychartRequest: pending, code, isTOTP: false });
  if (tfa.state !== "logged_in") return false;
  const client = await MyChartClient.fromSerialized(await tfa.mychartRequest.serialize(), { keepalive: false });
  if (!client) return false;
  await persistClient(account, client, inst);
  clients.set(account, client);
  manualPending.delete(account);
  return true;
}

const manualPending = new Map<string, MyChartRequest>();

/** Kick off a password login that stops at the 2FA challenge (for manual completion). */
export async function beginManualLogin(inst: InstanceConfig): Promise<"need_2fa" | "logged_in"> {
  const account = accountKey(inst);
  // When gmail creds exist, skip the portal's default send (engine retry order
  // hits SMS first on instances that hide their delivery buttons) and force
  // email ourselves. Without gmail, let the portal send via its default.
  const login = await myChartUserPassLogin({
    hostname: inst.hostname, user: inst.username, pass: inst.password,
    skipSendCode: !!inst.gmail,
  });
  if (login.state === "logged_in") {
    const client = await MyChartClient.fromSerialized(await login.mychartRequest.serialize(), { keepalive: false });
    if (client) {
      await persistClient(account, client, inst);
      clients.set(account, client);
      return "logged_in";
    }
  }
  if (login.state === "need_2fa") {
    if (inst.gmail) {
      const sent = await sendEmailCode(login.mychartRequest);
      if (!sent) throw new Error(`[${account}] could not force email code send; no code was delivered`);
      console.error(`[${account}] forced email SendCode ok (manual login)`);
    }
    manualPending.set(account, login.mychartRequest);
    return "need_2fa";
  }
  throw new Error(`[${account}] login failed: ${login.state}`);
}

export async function closeAll(): Promise<void> {
  await sql.end({ timeout: 1 });
}
