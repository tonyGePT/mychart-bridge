// MCP bridge server: minimal stateless JSON-RPC over streamable HTTP.
// Tools wrap the openrecord engine's full capability surface for every
// configured account, plus account/session management.

import { createServer as httpCreateServer } from "node:http";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { loadInstances, accountKey, type InstanceConfig } from "./config";
import { ensureSchema, getClient, checkStatus, completeManual2Fa, beginManualLogin, closeAll } from "./manager";
import { fetchSessionCsrfToken } from "../../openrecord/scrapers/myChart/core/csrf";
import { makeDispatcher, type ToolDef } from "./jsonrpc";
import {
  ensureOAuthSchema, isAuthorized, protectedResourceMetadata, authorizationServerMetadata,
  handleRegister, handleAuthorize, handleToken, ISSUER,
} from "./oauth";

const CAPABILITY_IDS = [
  "get_profile", "get_health_summary", "get_medications", "get_allergies", "get_health_issues",
  "get_vitals", "get_immunizations", "get_preventive_care", "get_medical_history", "get_goals",
  "get_upcoming_visits", "get_past_visits", "get_visit_notes", "get_note_content", "get_visit_avs",
  "get_lab_results", "get_imaging_results", "get_messages", "get_message_thread",
  "get_message_recipients", "get_message_topics", "send_message", "send_reply", "delete_message",
  "get_billing", "get_insurance", "get_care_team", "get_referrals", "get_letters",
  "get_letter_details", "get_documents", "get_upcoming_orders", "get_questionnaires",
  "get_care_journeys", "get_activity_feed", "get_education_materials", "get_ehi_export",
  "get_linked_accounts", "get_emergency_contacts", "add_emergency_contact",
  "update_emergency_contact", "remove_emergency_contact", "request_refill",
];

const instances = loadInstances();
const byAccount = new Map<string, InstanceConfig>();
for (const inst of instances) byAccount.set(accountKey(inst), inst);
for (const inst of instances) byAccount.set(inst.owner, inst); // owner alias

async function withClient(account: string, fn: (inst: InstanceConfig, client: Awaited<ReturnType<typeof getClient>>) => Promise<unknown>) {
  const inst = byAccount.get(account);
  if (!inst) throw new Error(`unknown account: ${account}. Known: ${[...byAccount.keys()].join(", ")}`);
  const client = await getClient(inst);
  return fn(inst, client);
}

function textResult(value: unknown, isError = false) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 1).slice(0, 500_000) }], isError };
}

const tools: ToolDef[] = [
  {
    name: "list_accounts",
    description: "List all configured MyChart accounts with connection status",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: async () => Promise.all(instances.map((i) => checkStatus(i))),
  },
  {
    name: "run_capability",
    description:
      "Run any openrecord capability against an account's live MyChart session. " +
      "Capabilities: " + CAPABILITY_IDS.join(", ") + ". " +
      "Arg shapes: send_message {subject,message,recipient?(provider display name),topic?}; send_reply {conversationId,message}; " +
      "request_refill {medication_name}.",
    inputSchema: {
      type: "object",
      properties: {
        account: { type: "string", description: "Account: owner ('bill'/'lenna') or 'owner:hostname'" },
        capability: { type: "string", description: "Capability id" },
        args: { type: "object", description: "Capability arguments", additionalProperties: true },
      },
      required: ["account", "capability"],
    },
    run: async (args) => {
      const { account, capability } = args as { account: string; capability: string };
      if (!CAPABILITY_IDS.includes(capability)) {
        throw new Error(`unknown capability ${capability}; valid: ${CAPABILITY_IDS.join(", ")}`);
      }
      const capArgs = (args.args ?? {}) as Record<string, unknown>;
      return withClient(account, (_inst, client) => client.runCapability(capability, capArgs));
    },
  },
  {
    name: "run_raw_endpoint",
    description:
      "Authenticated arbitrary portal API call through a live MyChart session — the escape hatch for " +
      "write flows not yet modeled as capabilities (bill pay, contact preferences, scheduling). " +
      "Path is instance-relative, e.g. '/api/bill-pay/GetBillPayData'. " +
      "CSRF token auto-attached. WARNING: POSTs with Save*/Pay*/Delete* MUTATE the account.",
    inputSchema: {
      type: "object",
      properties: {
        account: { type: "string", description: "Account: owner ('bill'/'lenna') or 'owner:hostname'" },
        method: { type: "string", enum: ["GET", "POST"], description: "HTTP method" },
        path: { type: "string", description: "Instance-relative path starting with /" },
        body: { type: "object", description: "JSON body (auto-stringified)", additionalProperties: true },
        needsCsrf: { type: "boolean", description: "Attach __RequestVerificationToken (default true for POST)" },
      },
      required: ["account", "method", "path"],
    },
    run: async (args) => {
      const { account, method, path } = args as { account: string; method: "GET" | "POST"; path: string };
      const body = args.body as Record<string, unknown> | undefined;
      const needsCsrf = args.needsCsrf as boolean | undefined;
      return withClient(account, async (_inst, client) => {
        const isPost = method === "POST";
        const headers: Record<string, string> = {};
        let payload: string | undefined;
        if (body !== undefined) {
          payload = JSON.stringify(body);
          headers["Content-Type"] = "application/json";
        }
        if (isPost && needsCsrf !== false) {
          const csrf = await fetchSessionCsrfToken(client.request);
          if (csrf) headers.__RequestVerificationToken = csrf;
        }
        const res = await client.request.makeRequest({ path, method, headers, body: payload });
        const text = await res.text();
        return { status: res.status, url: res.url, body: text.slice(0, 500_000) };
      });
    },
  },
  {
    name: "begin_login",
    description: "Kick off a manual password login for an account without an autonomous 2FA path. Returns need_2fa; then call complete_2fa with the code.",
    inputSchema: {
      type: "object",
      properties: { account: { type: "string" } },
      required: ["account"],
    },
    run: async (args) => {
      const inst = byAccount.get(args.account as string);
      if (!inst) throw new Error(`unknown account: ${args.account}`);
      const state = await beginManualLogin(inst);
      return { account: args.account, state };
    },
  },
  {
    name: "complete_2fa",
    description: "Complete a pending 2FA challenge with a human-provided code",
    inputSchema: {
      type: "object",
      properties: { account: { type: "string" }, code: { type: "string", description: "6-digit code" } },
      required: ["account", "code"],
    },
    run: async (args) => {
      const inst = byAccount.get(args.account as string);
      if (!inst) throw new Error(`unknown account: ${args.account}`);
      const ok = await completeManual2Fa(inst, args.code as string);
      return { account: args.account, ok };
    },
  },
  {
    name: "care_team_real",
    description: "Care team / provider list with Relation (PCP/specialist), Specialty, and CanMessage flag. " +
      "Uses POST /Clinical/CareTeam/Load (shape captured live 2026-08-27). Also returns LoadExternal providers.",
    inputSchema: {
      type: "object",
      properties: { account: { type: "string", description: "Account: owner or 'owner:hostname'" } },
      required: ["account"],
    },
    run: async (args) => withClient(args.account as string, async (_inst, client) => {
      const csrf = await fetchSessionCsrfToken(client.request);
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (csrf) headers.__RequestVerificationToken = csrf;
      const load = await client.request.makeRequest({ path: "/Clinical/CareTeam/Load", method: "POST", headers, body: "{}" });
      const loadJson = await load.json().catch(() => null);
      const ext = await client.request.makeRequest({ path: "/Clinical/CareTeam/LoadExternal", method: "POST", headers, body: "{}" });
      const extJson = await ext.json().catch(() => null);
      return {
        providers: loadJson?.ProvidersList ?? [],
        externalProviders: extJson?.ProvidersList ?? [],
      };
    }),
  },
  {
    name: "test_result_details",
    description: "Full detail of one test result (per-component results, reference ranges, comments). " +
      "Get orderKey from run_capability get_lab_results output.",
    inputSchema: {
      type: "object",
      properties: {
        account: { type: "string", description: "Account: owner or 'owner:hostname'" },
        orderKey: { type: "string", description: "Result orderKey from get_lab_results" },
      },
      required: ["account", "orderKey"],
    },
    run: async (args) => withClient(args.account as string, async (_inst, client) => {
      const csrf = await fetchSessionCsrfToken(client.request);
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (csrf) headers.__RequestVerificationToken = csrf;
      const res = await client.request.makeRequest({
        path: "/api/test-results/GetDetails", method: "POST", headers,
        body: JSON.stringify({ orderKey: args.orderKey, organizationID: "", PageNonce: "" }),
      });
      return res.json().catch(() => null);
    }),
  },
  {
    name: "medication_history",
    description: "Full medication history (all-time, incl. external/linked-org meds), not just the active list. " +
      "filter: 'all' | 'active' | 'asNeeded' etc. — 'all' returns complete history.",
    inputSchema: {
      type: "object",
      properties: {
        account: { type: "string", description: "Account: owner or 'owner:hostname'" },
        filter: { type: "string", description: "Page filter, default 'all'" },
      },
      required: ["account"],
    },
    run: async (args) => withClient(args.account as string, async (_inst, client) => {
      const csrf = await fetchSessionCsrfToken(client.request);
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (csrf) headers.__RequestVerificationToken = csrf;
      const res = await client.request.makeRequest({
        path: "/api/medications/LoadMedicationsPage", method: "POST", headers,
        body: JSON.stringify({ filter: (args.filter as string) ?? "all" }),
      });
      return res.json().catch(() => null);
    }),
  },
  {
    name: "send_message_many",
    description: "Send the same message to one or many providers. recipients[] items: " +
      "{recipientType, displayName, specialty, userId, departmentId, poolId, providerId, organizationId} — " +
      "get them from run_capability get_message_recipients. topic: {displayName, value} from get_message_topics.",
    inputSchema: {
      type: "object",
      properties: {
        account: { type: "string", description: "Account: owner or 'owner:hostname'" },
        recipients: {
          type: "array",
          description: "One or many recipient structs (from get_message_recipients)",
          items: { type: "object", additionalProperties: true },
        },
        topic: { type: "object", description: "{displayName, value} from get_message_topics", additionalProperties: true },
        subject: { type: "string", description: "Message subject" },
        message: { type: "string", description: "Message body" },
      },
      required: ["account", "recipients", "topic", "subject", "message"],
    },
    run: async (args) => withClient(args.account as string, async (_inst, client) => {
      const recipients = args.recipients as Record<string, unknown>[];
      const topic = args.topic as Record<string, unknown>;
      const results = [];
      for (const recipient of recipients) {
        try {
          const r = await client.runCapability("send_message", {
            recipient, topic,
            subject: args.subject as string,
            message: args.message as string,
          });
          results.push({ recipient: (recipient as { displayName?: string }).displayName, ok: true, result: r });
        } catch (err) {
          results.push({ recipient: (recipient as { displayName?: string }).displayName, ok: false, error: String(err).slice(0, 200) });
        }
      }
      return { sent: results.filter((x) => x.ok).length, failed: results.filter((x) => !x.ok).length, results };
    }),
  },
];

export async function startServer(port: number): Promise<void> {
  await ensureSchema();
  await ensureOAuthSchema();
  const handle = makeDispatcher(tools);
  const httpServer = httpCreateServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    try {
      if (url.pathname === "/healthz") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, accounts: instances.map((i) => accountKey(i)) }));
        return;
      }
      if (url.pathname === "/.well-known/oauth-protected-resource" || url.pathname === "/.well-known/oauth-protected-resource/mcp") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(await protectedResourceMetadata().json()));
        return;
      }
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(await authorizationServerMetadata().json()));
        return;
      }
      if (url.pathname === "/register" && req.method === "POST") {
        const out = await handleRegister(new Request(ISSUER + "/register", { method: "POST", body: await readBody(req) }));
        res.writeHead(out.status, { "Content-Type": "application/json" });
        res.end(await out.text());
        return;
      }
      if (url.pathname === "/authorize") {
        const method = req.method ?? "GET";
        const bodyText = method === "POST" ? await readBody(req) : "";
        const target = new URL(ISSUER + "/authorize" + (method === "GET" ? (url.search || "") : ""));
        const out = await handleAuthorize(new Request(target, {
          method,
          ...(method === "POST" ? { body: bodyText, headers: { "Content-Type": "application/x-www-form-urlencoded" } } : {}),
        }));
        const loc = out.headers.get("location");
        if (loc) { res.writeHead(302, { Location: loc }); res.end(); return; }
        res.writeHead(out.status, { "Content-Type": out.headers.get("content-type") ?? "text/html" });
        res.end(await out.text());
        return;
      }
      if (url.pathname === "/token" && req.method === "POST") {
        const out = await handleToken(new Request(ISSUER + "/token", {
          method: "POST",
          body: await readBody(req),
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
        }));
        res.writeHead(out.status, { "Content-Type": "application/json" });
        res.end(await out.text());
        return;
      }
      if (url.pathname.startsWith("/mcp")) {
        const ok = await isAuthorized(new Request(ISSUER + url.pathname + url.search, {
          method: req.method,
          headers: req.headers as unknown as HeadersInit,
        }));
        console.error(`[/mcp] ${req.method} authed=${ok}`);
        if (!ok) {
          console.error("[/mcp] REJECTING with 401");
          res.writeHead(401, {
            "Content-Type": "application/json",
            "WWW-Authenticate": `Bearer resource_metadata="${ISSUER}/.well-known/oauth-protected-resource"`,
          });
          res.end(JSON.stringify({ error: "unauthorized" }));
          return;
        }
        let body = "";
        req.on("data", (c: Buffer) => { body += c.toString(); });
        req.on("end", async () => {
          try {
            await handle(req, res, body);
          } catch (err) {
            console.error("mcp error", err);
            if (!res.headersSent) {
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: String(err) }));
            }
          }
        });
        return;
      }
      res.writeHead(404).end();
    } catch (err) {
      console.error("server error", err);
      if (!res.headersSent) res.writeHead(500).end(JSON.stringify({ error: String(err) }));
    }
  });
  await new Promise<void>((resolve) => httpServer.listen(port, () => resolve()));
  console.log(`mychart-bridge listening on :${port} (accounts: ${instances.map((i) => accountKey(i)).join(", ")})`);
}

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c: Buffer) => { body += c.toString(); });
    req.on("end", () => resolve(body));
  });
}

process.on("SIGTERM", async () => { await closeAll(); process.exit(0); });

// Bootstrap when run directly
if (import.meta.main) {
  const port = Number(process.env.PORT ?? 8080);
  await startServer(port);
}
