// MCP streamable-HTTP server exposing the full openrecord capability surface
// for every configured account, plus account/session management tools.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { createServer as httpCreateServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { loadInstances, bridgeApiKey, accountKey, type InstanceConfig } from "./config";
import { ensureSchema, getClient, checkStatus, completeManual2Fa, beginManualLogin, closeAll } from "./manager";

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

function buildServer(): McpServer {
const server = new McpServer({ name: "mychart-bridge", version: "1.0.0" });

server.tool(
  "list_accounts",
  "List all configured MyChart accounts with connection status",
  {},
  async () => {
    const statuses = await Promise.all(instances.map((i) => checkStatus(i)));
    return { content: [{ type: "text", text: JSON.stringify(statuses, null, 1) }] };
  },
);

server.tool(
  "run_capability",
  "Run any openrecord capability against an account's live MyChart session. " +
  "Capabilities: " + CAPABILITY_IDS.join(", ") + ". " +
  "Arg shapes: send_message {subject,message,recipient?(provider display name),topic?}; send_reply {conversationId,message}; " +
  "request_refill {medication_name}; get_note_content/get_message_thread/get_visit_notes need {csn} or {messageId} — see sibling list output.",
  {
    account: z.string().describe("Account: owner ('bill'/'lenna') or 'owner:hostname'"),
    capability: z.string().describe("Capability id"),
    args: z.record(z.unknown()).optional().describe("Capability arguments"),
  },
  async ({ account, capability, args }) => {
    if (!CAPABILITY_IDS.includes(capability)) {
      throw new Error(`unknown capability ${capability}; valid: ${CAPABILITY_IDS.join(", ")}`);
    }
    const result = await withClient(account, (_inst, client) =>
      client.runCapability(capability, args ?? {}));
    return { content: [{ type: "text", text: JSON.stringify(result, null, 1).slice(0, 100_000) }] };
  },
);

server.tool(
  "begin_login",
  "Kick off a manual password login for an account without an autonomous 2FA path. Returns need_2fa; then call complete_2fa with the code.",
  { account: z.string() },
  async ({ account }) => {
    const inst = byAccount.get(account);
    if (!inst) throw new Error(`unknown account: ${account}`);
    const state = await beginManualLogin(inst);
    return { content: [{ type: "text", text: JSON.stringify({ account, state }) }] };
  },
);

server.tool(
  "complete_2fa",
  "Complete a pending 2FA challenge with a human-provided code",
  { account: z.string(), code: z.string().describe("6-digit code") },
  async ({ account, code }) => {
    const inst = byAccount.get(account);
    if (!inst) throw new Error(`unknown account: ${account}`);
    const ok = await completeManual2Fa(inst, code);
    return { content: [{ type: "text", text: JSON.stringify({ account, ok }) }] };
  },
);
  return server;
} // buildServer

// ---- HTTP wiring: bearer auth + stateless streamable HTTP sessions ----
const transports = new Map<string, StreamableHTTPServerTransport>();

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = req.headers.authorization ?? "";
  if (auth !== `Bearer ${bridgeApiKey()}`) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  let transport: StreamableHTTPServerTransport | undefined;
  if (sessionId) {
    transport = transports.get(sessionId);
    if (!transport) {
      res.writeHead(404).end(JSON.stringify({ error: "unknown session" }));
      return;
    }
  } else if (req.method === "POST") {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => { transports.set(sid, transport as StreamableHTTPServerTransport); },
    });
    transport.onclose = () => {
      const sid = transport?.sessionId;
      if (sid) transports.delete(sid);
    };
    await buildServer().connect(transport);
  }
  if (!transport) {
    res.writeHead(400).end(JSON.stringify({ error: "bad request" }));
    return;
  }
  await transport.handleRequest(req, res);
}

export async function startServer(port: number): Promise<void> {
  await ensureSchema();
  const httpServer = httpCreateServer(async (req, res) => {
    if (req.url?.startsWith("/mcp")) {
      await handleMcp(req, res).catch((err) => {
        console.error("mcp error", err);
        if (!res.headersSent) res.writeHead(500).end(JSON.stringify({ error: String(err) }));
      });
      return;
    }
    if (req.url?.startsWith("/healthz")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, accounts: instances.map((i) => accountKey(i)) }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => httpServer.listen(port, () => resolve()));
  console.log(`mychart-bridge listening on :${port} (accounts: ${instances.map((i) => accountKey(i)).join(", ")})`);
}

process.on("SIGTERM", async () => { await closeAll(); process.exit(0); });

// Bootstrap when run directly
if (import.meta.main) {
  const port = Number(process.env.PORT ?? 8080);
  await startServer(port);
}
