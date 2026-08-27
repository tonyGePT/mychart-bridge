// Minimal stateless JSON-RPC (MCP streamable-HTTP) dispatcher.
// Replaces the SDK transport whose body handling is unreliable on bun 1.4.
// Supports exactly what this bridge needs: initialize, notifications,
// tools/list, tools/call.

import type { IncomingMessage, ServerResponse } from "node:http";
import { bridgeApiKey } from "./config";

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (args: Record<string, unknown>) => Promise<unknown>;
}

export function makeDispatcher(tools: ToolDef[]) {
  const toolsList = {
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  };

  return async function handle(
    req: IncomingMessage,
    res: ServerResponse,
    body: string,
  ): Promise<void> {
    const auth = req.headers.authorization ?? "";
    if (auth !== `Bearer ${bridgeApiKey()}`) {
      return sendJson(res, 401, { error: "unauthorized" });
    }

    let msg: any;
    try {
      msg = JSON.parse(body);
    } catch {
      return sendJson(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    }
    if (Array.isArray(msg)) {
      return sendJson(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Batch not supported" } });
    }
    const { id, method, params } = msg ?? {};
    const isNotification = id === undefined || id === null;

    const reply = (result: unknown) => sendJson(res, 200, { jsonrpc: "2.0", id, result });
    const rpcError = (code: number, message: string) =>
      sendJson(res, 200, { jsonrpc: "2.0", id, error: { code, message } });

    switch (method) {
      case "initialize":
        return reply({
          protocolVersion: params?.protocolVersion ?? "2025-03-26",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "mychart-bridge", version: "1.0.0" },
        });
      case "notifications/initialized":
      case "notifications/cancelled":
      case "notifications/roots/list_changed":
        // Notifications: no body per spec
        res.writeHead(202, { "Content-Length": "0" });
        res.end();
        return;
      case "ping":
        return reply({});
      case "tools/list":
        return reply(toolsList);
      case "tools/call": {
        const name = params?.name as string | undefined;
        const tool = tools.find((t) => t.name === name);
        if (!tool) {
          return rpcError(-32602, `unknown tool: ${name}`);
        }
        try {
          const args = (params?.arguments ?? {}) as Record<string, unknown>;
          const raw = await tool.run(args);
          // MCP tools must return a content envelope; wrap raw values.
          const result = (raw !== null && typeof raw === "object" && "content" in raw)
            ? raw as { content: unknown; isError?: boolean }
            : { content: [{ type: "text", text: JSON.stringify(raw, null, 1).slice(0, 500_000) }] };
          return reply(result);
        } catch (err) {
          return reply({
            content: [{ type: "text", text: String((err as Error)?.message ?? err) }],
            isError: true,
          });
        }
      }
      case "prompts/list":
        return reply({ prompts: [] });
      case "resources/list":
        return reply({ resources: [] });
      default:
        if (isNotification) {
          res.writeHead(202, { "Content-Length": "0" });
          res.end();
          return;
        }
        return rpcError(-32601, `method not found: ${method}`);
    }
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
  res.end(payload);
}
