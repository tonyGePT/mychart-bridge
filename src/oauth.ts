// Minimal OAuth 2.0 authorization server for ChatGPT web connectors.
// Flow: discovery metadata -> dynamic client registration -> /authorize consent
// (guarded by the bridge access code) -> PKCE-verified code exchange -> opaque
// long-lived bearer token stored in Postgres. Mom consents ONCE.

import postgres from "postgres";
import { createHash, randomBytes } from "node:crypto";
import { databaseUrl, bridgeApiKey } from "./config";

const sql = postgres(databaseUrl(), { max: 3, idle_timeout: 20 });

export const ISSUER = process.env.PUBLIC_BASE_URL ?? "https://mychart-bridge-mcp.fly.dev";

export async function ensureOAuthSchema(): Promise<void> {
  await sql`create table if not exists oauth_codes (
    code text primary key,
    client_id text not null,
    redirect_uri text not null,
    challenge text not null,
    created_at timestamptz not null default now()
  )`;
  await sql`create table if not exists oauth_tokens (
    token text primary key,
    created_at timestamptz not null default now(),
    expires_at timestamptz not null
  )`;
}

/** Static bridge key OR a valid issued access token. */
export async function isAuthorized(req: Request): Promise<boolean> {
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return false;
  const token = auth.slice(7).trim();
  if (token === bridgeApiKey()) return true;
  try {
    const rows = await sql`select 1 from oauth_tokens where token = ${token} and expires_at > now() limit 1`;
    return rows.length > 0;
  } catch (e) {
    console.error("[auth] db error:", String(e).slice(0, 200));
    return false;
  }
}

export function oauthError(res: ResponseInit & { headers?: HeadersInit }, status: number, body: unknown): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...(res.headers as HeadersInit | undefined) },
  });
}

/** RFC 9728 protected-resource metadata; points ChatGPT at our auth server. */
export function protectedResourceMetadata(): Response {
  return Response.json({
    resource: ISSUER,
    authorization_servers: [ISSUER],
    scopes_supported: ["mychart"],
    bearer_methods_supported: ["header"],
  });
}

export function authorizationServerMetadata(): Response {
  return Response.json({
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/authorize`,
    token_endpoint: `${ISSUER}/token`,
    registration_endpoint: `${ISSUER}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["mychart"],
  });
}

/** RFC 7591 dynamic client registration — ChatGPT registers itself. */
export async function handleRegister(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const clientId = "mcb_" + randomBytes(12).toString("hex");
  return Response.json({
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: (body.client_name as string) ?? "ChatGPT",
    redirect_uris: (body.redirect_uris as string[]) ?? [],
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    scope: "mychart",
  });
}

function s256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function consentPage(params: URLSearchParams, error?: string): Response {
  const hidden = ["client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method", "scope", "resource"]
    .map((k) => {
      const v = params.get(k);
      return v !== null && v !== "" ? `<input type="hidden" name="${k}" value="${v.replace(/"/g, "&quot;")}"/>` : "";
    })
    .join("\n");
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MyChart Bridge — Connect</title>
<style>body{font-family:-apple-system,sans-serif;background:#f4f6f8;display:flex;justify-content:center;padding:40px 16px}
.card{background:#fff;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,.12);max-width:420px;width:100%;padding:28px}
h1{font-size:20px;margin:0 0 8px}p{color:#555;font-size:14px;line-height:1.5}
input[type=password]{width:100%;padding:12px;border:1px solid #ccc;border-radius:8px;font-size:16px;box-sizing:border-box;margin:12px 0}
button{width:100%;padding:12px;background:#0b7285;color:#fff;border:0;border-radius:8px;font-size:16px}
.err{color:#c0392b;font-size:13px}</style></head><body><div class="card">
<h1>Connect MyChart Bridge</h1>
<p>Grant this app access to the family MyChart bridge (read: chart data & messages — write: messages & refills only when approved in-chat).</p>
${error ? `<p class="err">${error}</p>` : ""}
<form method="POST" action="/authorize">
${hidden}
<input type="password" name="access_code" placeholder="Bridge access code" required autofocus/>
<button type="submit">Authorize</button>
</form></div></body></html>`;
  return new Response(html, { status: error ? 401 : 200, headers: { "Content-Type": "text/html" } });
}

export async function handleAuthorize(req: Request): Promise<Response> {
  if (req.method === "GET") {
    const url = new URL(req.url);
    const required = ["client_id", "redirect_uri", "code_challenge"];
    const missing = required.filter((k) => !url.searchParams.get(k));
    if (missing.length) return consentPage(url.searchParams, "Missing connection parameters.");
    return consentPage(url.searchParams);
  }
  // POST: consent submitted
  const form = new URLSearchParams(await req.text());
  const accessCode = form.get("access_code") ?? "";
  if (accessCode !== bridgeApiKey()) {
    return consentPage(form, "Incorrect access code. Ask Anthony for the bridge code.");
  }
  const clientId = form.get("client_id") ?? "";
  const redirectUri = form.get("redirect_uri") ?? "";
  const challenge = form.get("code_challenge") ?? "";
  const state = form.get("state") ?? "";
  if (!clientId || !redirectUri || !challenge) {
    return consentPage(form, "Missing connection parameters.");
  }
  const code = randomBytes(24).toString("hex");
  await sql`insert into oauth_codes (code, client_id, redirect_uri, challenge) values (${code}, ${clientId}, ${redirectUri}, ${challenge})`;
  const redirect = new URL(redirectUri);
  redirect.searchParams.set("code", code);
  if (state) redirect.searchParams.set("state", state);
  return new Response(null, { status: 302, headers: { Location: redirect.toString() } });
}

export async function handleToken(req: Request): Promise<Response> {
  const form = new URLSearchParams(await req.text());
  const grantType = form.get("grant_type");
  if (grantType !== "authorization_code") {
    return oauthError({}, 400, { error: "unsupported_grant_type" });
  }
  const code = form.get("code") ?? "";
  const verifier = form.get("code_verifier") ?? "";
  const clientId = form.get("client_id") ?? "";
  const redirectUri = form.get("redirect_uri") ?? "";
  const rows = await sql`select client_id, redirect_uri, challenge, created_at from oauth_codes where code = ${code} limit 1`;
  if (rows.length === 0) return oauthError({}, 400, { error: "invalid_grant", error_description: "unknown or expired code" });
  const row = rows[0] as { client_id: string; redirect_uri: string; challenge: string; created_at: string };
  await sql`delete from oauth_codes where code = ${code}`;
  if (row.client_id !== clientId || row.redirect_uri !== redirectUri) {
    return oauthError({}, 400, { error: "invalid_grant", error_description: "client/redirect mismatch" });
  }
  if (Date.now() - new Date(row.created_at).getTime() > 10 * 60 * 1000) {
    return oauthError({}, 400, { error: "invalid_grant", error_description: "code expired" });
  }
  if (s256(verifier) !== row.challenge) {
    return oauthError({}, 400, { error: "invalid_grant", error_description: "PKCE verification failed" });
  }
  const token = "mcbt_" + randomBytes(32).toString("hex");
  await sql`insert into oauth_tokens (token, expires_at) values (${token}, now() + interval '365 days')`;
  return Response.json({
    access_token: token,
    token_type: "Bearer",
    expires_in: 365 * 24 * 3600,
    scope: "mychart",
  });
}
