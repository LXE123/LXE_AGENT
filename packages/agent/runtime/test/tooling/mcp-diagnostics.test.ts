import { expect, spyOn, test } from "bun:test";
import * as network from "../../src/network/fetch";
import { createLogger, runWithLogContext } from "@lxe/core";
import { McpManager, OfficialMcpConnector, type McpServerConfig } from "../../src/tooling/mcp";
import { ToolRegistry } from "../../src/tooling/registry";
import { legacyReply, type WireMessage } from "./protocol-mcp-server.fixture";

const config = (url: string, overrides: Partial<McpServerConfig> = {}): McpServerConfig => ({
  name: "diagnostic-fixture", enabled: true, transport: "streamable-http", protocolMode: "auto", url,
  command: "", args: [], env: {}, cwd: "", headers: {}, envHeaders: {}, bearerTokenEnvVar: "",
  connectorId: "fixture", connectorName: "", connectorDescription: "", startupTimeoutMs: 1_000,
  toolTimeoutMs: 1_000, enabledTools: new Set(), disabledTools: new Set(), exposure: "codemode", ...overrides,
});
const recorder = () => {
  const rows: Record<string, any>[] = [];
  return { rows, logger: createLogger("mcp-test", { write: line => rows.push(JSON.parse(line)) }) };
};

test("HTTP fallback, paginated tool discovery and SSE replies have correlated startup timings", async () => {
  const { rows, logger } = recorder();
  const http = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const message = await request.json() as WireMessage;
    const reply = legacyReply(message);
    if (!reply) return new Response(null, { status: 202 });
    if (message.method === "tools/list") {
      // Headers arrive before the RPC result; the stream stays open after the result.
      let timer: ReturnType<typeof setTimeout>;
      return new Response(new ReadableStream({
        start(controller) { timer = setTimeout(() => controller.enqueue(new TextEncoder().encode(`event: message\ndata: ${JSON.stringify(reply)}\n\n`)), 25); },
        cancel() { clearTimeout(timer); },
      }), { headers: { "content-type": "text/event-stream" } });
    }
    return Response.json(reply, { status: message.method === "server/discover" ? 400 : 200 });
  } });
  let connection;
  try {
    connection = await runWithLogContext({ session_id: "chat-a", turn_id: "turn-a" }, () =>
      new OfficialMcpConnector({}, undefined, undefined, logger).connect(config(http.url.href)));
    expect(connection.tools).toHaveLength(2);
    const completed = rows.filter(row => row.message === "mcp_connection_stage_completed");
    expect(completed.map(row => row.stage)).toContain("initialize");
    expect(completed.filter(row => row.stage === "tools/list")).toHaveLength(2);
    expect(completed.filter(row => row.stage === "tools/list").every(row => row.duration_ms >= 20)).toBe(true);
    expect(rows.some(row => row.message === "mcp_connection_http_response" && row.rpc_method === "server/discover" && row.http_status === 400)).toBe(true);
    expect(rows.some(row => row.stage === "server/discover" && row.error?.code === -32601)).toBe(true);
    expect(rows.at(-1)).toMatchObject({ message: "mcp_connection_completed", tool_count: 2, protocol_era: "legacy" });
    expect(new Set(rows.map(row => row.connection_attempt_id)).size).toBe(1);
    expect(rows.every(row => row.session_id === "chat-a" && row.turn_id === "turn-a")).toBe(true);
    const before = rows.length;
    await connection.callTool("echo", {});
    expect(rows).toHaveLength(before); // Startup tracing must not dump normal tool calls/results.
  } finally { await connection?.close(); await http.stop(true); }
});

for (const stage of ["server/discover", "initialize", "tools/list"]) {
  test(`startup timeout identifies ${stage}, including a stalled body after HTTP headers`, async () => {
    const { rows, logger } = recorder();
    const http = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      if (request.method !== "POST") return new Response(null, { status: 405 });
      const message = await request.json() as WireMessage;
      if (message.method === stage) return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode(": keepalive\n\n"));
      } }), { headers: { "content-type": "text/event-stream" } });
      const reply = legacyReply(message);
      return reply ? Response.json(reply) : new Response(null, { status: 202 });
    } });
    const server = config(http.url.href, { startupTimeoutMs: 200 });
    const manager = new McpManager({ servers: [server] }, new OfficialMcpConnector({}, undefined, undefined, logger));
    try {
      await manager.start(new ToolRegistry());
      expect(manager.status(server.name).error).toContain("startup timed out after 200ms");
      expect(rows.some(row => row.message === "mcp_connection_http_response" && row.rpc_method === stage && row.http_status === 200)).toBe(true);
      const failed = rows.find(row => row.message === "mcp_connection_stage_failed" && row.stage === stage);
      expect(failed?.error.message).toContain("startup timed out after 200ms");
      expect(failed?.duration_ms).toBeGreaterThan(100);
      expect(rows.some(row => row.message === "mcp_connection_stage_completed" && row.stage === stage)).toBe(false);
      expect(rows.filter(row => row.message === "mcp_connection_failed")).toHaveLength(1);
    } finally { await manager.stop(); await http.stop(true); }
  });
}

test("actual HTTP error diagnostics retain status and upstream detail but redact known secrets", async () => {
  const { rows, logger } = recorder();
  const token = "fixture-oauth-private", header = "fixture-header-private", query = "fixture-url-private";
  const http = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(
    `upstream failure: ${token} ${header} ${query}`, { status: 503 }) });
  try {
    const connector = new OfficialMcpConnector({}, undefined, () => token, logger);
    await expect(connector.connect(config(http.url.href + "?key=" + query, { headers: { "X-Custom": header } }))).rejects.toThrow("503");
    const log = JSON.stringify(rows);
    for (const secret of [token, header, query]) expect(log).not.toContain(secret);
    expect(log).toContain("upstream failure");
    expect(log).toContain("[redacted]");
    expect(rows.some(row => row.stage === "server/discover" && row.error_data?.status === 503)).toBe(true);
  } finally { await http.stop(true); }
});

test("transport failures preserve the original error and cause in the request stage", async () => {
  const { rows, logger } = recorder();
  const cause = new Error("fixture connection reset");
  const error = new TypeError("fixture socket closed unexpectedly", { cause });
  const fetchSpy = spyOn(network, "harnessFetch").mockRejectedValue(error);
  try {
    await expect(new OfficialMcpConnector({}, undefined, undefined, logger)
      .connect(config("http://127.0.0.1:1/mcp"))).rejects.toThrow("fixture socket closed unexpectedly");
    expect(rows.find(row => row.message === "mcp_connection_http_failed")).toMatchObject({
      rpc_method: "server/discover", error: { message: error.message, cause: { message: cause.message } },
    });
    expect(rows.find(row => row.stage === "server/discover" && row.message === "mcp_connection_stage_failed")?.error.message).toBe(error.message);
  } finally { fetchSpy.mockRestore(); }
});
