import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { ProtocolError, Server, type CallToolResult, type JSONRPCMessage } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

export type WireMessage = { method?: string; id?: string | number; params?: Record<string, any> };

export const fixtureTools = ["echo", "second"].map(name => ({ name, inputSchema: { type: "object" as const } }));
export const fixtureFailure = `actual upstream rejection: token=private-value ${"x".repeat(3_000)} end-of-error`;

export function fixtureResult(arguments_: Record<string, unknown> = {}): CallToolResult {
  if (arguments_.protocolError) throw new ProtocolError(-32602, "actual protocol rejection", { diagnostic: fixtureFailure });
  if (arguments_.failure) return { content: [{ type: "text", text: fixtureFailure }], isError: true };
  return {
    content: [{ type: "text", text: "fixture result" }],
    ...(Object.hasOwn(arguments_, "value") ? { structuredContent: arguments_.value } : {}),
  };
}

export function modernFixture(onCancel: () => void = () => {}): Server {
  const server = new Server({ name: "protocol-fixture", version: "1" }, { capabilities: { tools: {} } });
  server.setRequestHandler("tools/list", async request => request.params?.cursor === "second-page"
    ? { tools: [fixtureTools[1]!] }
    : { tools: [fixtureTools[0]!], nextCursor: "second-page" });
  server.setRequestHandler("tools/call", async (request, context) => {
    if (request.params.arguments?.hang) {
      await new Promise<void>((resolve) => {
        const cancelled = () => { onCancel(); resolve(); };
        if (context.mcpReq.signal.aborted) cancelled();
        else context.mcpReq.signal.addEventListener("abort", cancelled, { once: true });
      });
    }
    return fixtureResult(request.params.arguments);
  });
  return server;
}

// Independent legacy wire fixture: deliberately does not use the upgraded SDK.
export function legacyReply(message: WireMessage): Record<string, unknown> | undefined {
  if (message.id === undefined) return;
  const base = { jsonrpc: "2.0", id: message.id };
  switch (message.method) {
    case "initialize": return { ...base, result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "legacy-fixture", version: "1" } } };
    case "tools/list": return { ...base, result: message.params?.cursor === "second-page"
      ? { tools: [fixtureTools[1]!] } : { tools: [fixtureTools[0]!], nextCursor: "second-page" } };
    case "tools/call": return { ...base, result: fixtureResult(message.params?.arguments) };
    default: return { ...base, error: { code: -32601, message: `Unknown method: ${message.method}` } };
  }
}

if (import.meta.main) {
  const [mode = "modern", tracePath] = process.argv.slice(2);
  const trace = (event: Record<string, unknown>) => {
    if (tracePath) appendFileSync(tracePath, JSON.stringify({ pid: process.pid, ...event }) + "\n");
  };
  trace({ event: "spawn" });
  process.on("exit", () => trace({ event: "exit" }));
  let buffer = "";
  process.stdin.on("data", chunk => {
    buffer += chunk.toString();
    for (let newline; (newline = buffer.indexOf("\n")) !== -1;) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (line.trim()) trace({ event: "request", message: JSON.parse(line) as JSONRPCMessage });
    }
  });
  if (mode === "modern") {
    serveStdio(() => modernFixture(() => trace({ event: "cancelled" })));
  } else {
    const input = createInterface({ input: process.stdin });
    for await (const line of input) {
      const message = JSON.parse(line) as WireMessage;
      if (mode === "silent") continue;
      if (mode === "exit-on-probe" && message.method === "server/discover") process.exit(0);
      if (mode === "exit-on-call" && message.method === "tools/call") process.exit(17);
      const reply = legacyReply(message);
      if (reply) process.stdout.write(JSON.stringify(reply) + "\n");
    }
  }
}
