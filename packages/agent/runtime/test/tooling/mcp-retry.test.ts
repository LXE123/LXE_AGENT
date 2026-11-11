import { expect, spyOn, test } from "bun:test";
import * as network from "../../src/network/fetch";
import { ProtocolError, SdkError, SdkErrorCode, SdkHttpError } from "@modelcontextprotocol/client";
import { McpManager, OfficialMcpConnector, type McpConnection, type McpServerConfig } from "../../src/tooling/mcp";
import { McpLoginRequired } from "../../src/tooling/mcp/connector";
import { isTransientMcpHttpError, mcpFailureText } from "../../src/tooling/mcp/support";
import { ToolRegistry } from "../../src/tooling/registry";
import { legacyReply, type WireMessage } from "./protocol-mcp-server.fixture";

const config = (overrides: Partial<McpServerConfig> = {}): McpServerConfig => ({
  name: "retry-fixture", enabled: true, transport: "streamable-http", protocolMode: "auto",
  url: "http://127.0.0.1:1/mcp", command: "fixture", args: [], env: {}, cwd: "",
  headers: {}, envHeaders: {}, bearerTokenEnvVar: "", connectorId: "fixture", connectorName: "",
  connectorDescription: "", startupTimeoutMs: 1_000, toolTimeoutMs: 1_000,
  enabledTools: new Set(), disabledTools: new Set(), exposure: "codemode", ...overrides,
});
const connection = (): McpConnection => ({
  tools: [{ name: "echo" }], callTool: async () => ({ content: [] }), close: async () => {},
});
const httpError = (status: number) => new SdkHttpError(SdkErrorCode.EraNegotiationFailed,
  `actual HTTP ${status} failure`, { status, text: "upstream diagnostic" });

test("transient classification follows Pi and unwraps only the SDK's actual probe network cause", () => {
  for (const status of [408, 429, 500, 502, 503, 504]) expect(isTransientMcpHttpError(httpError(status))).toBe(true);
  for (const status of [400, 401, 403, 404, 501]) expect(isTransientMcpHttpError(httpError(status))).toBe(false);
  const network = new TypeError("socket closed unexpectedly");
  expect(isTransientMcpHttpError(network)).toBe(true);
  expect(isTransientMcpHttpError(new SdkError(SdkErrorCode.EraNegotiationFailed,
    "probe failed", { cause: network }, { cause: network }))).toBe(true);
  for (const error of [
    new Error("socket closed unexpectedly"), new DOMException("Cancelled", "AbortError"),
    new SdkError(SdkErrorCode.EraNegotiationFailed, "unsupported protocol"),
    new SdkError(SdkErrorCode.EraNegotiationFailed, "invalid JSON", undefined, { cause: new SyntaxError("invalid JSON") }),
    new ProtocolError(-32601, "unknown method"), new McpLoginRequired({ url: "https://fixture/mcp" }, httpError(401)),
  ]) expect(isTransientMcpHttpError(error)).toBe(false);
});

for (const stage of ["server/discover", "initialize", "tools/list"]) {
  test(`real SDK retries network failures at ${stage} with fresh clients and complete tool discovery`, async () => {
    const requests: WireMessage[] = [], failedAt: number[] = [];
    let attempts = 0, closes = 0;
    const http = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      if (request.method !== "POST") return new Response(null, { status: 405 });
      const message = await request.json() as WireMessage;
      const reply = legacyReply(message);
      return reply ? Response.json(reply) : new Response(null, { status: 202 });
    } });
    const realFetch = network.harnessFetch;
    const fetchSpy = spyOn(network, "harnessFetch").mockImplementation(async (...[input, init]: Parameters<typeof network.harnessFetch>) => {
      if (new URL(String(input)).origin === http.url.origin && init?.method === "POST") {
        const message = JSON.parse(String(init.body)) as WireMessage;
        requests.push(message);
        if (message.method === stage && failedAt.length < 2) {
          failedAt.push(performance.now());
          throw new TypeError(`fixture socket closed at ${stage}`);
        }
      }
      return realFetch(input, init);
    });
    const official = new OfficialMcpConnector({});
    const server = config({ url: http.url.href });
    const registry = new ToolRegistry();
    const manager = new McpManager({ servers: [server] }, { connect: async (entry, signal) => {
      attempts++;
      const result = await official.connect(entry, signal);
      return { ...result, close: async () => { closes++; await result.close(); } };
    } });
    try {
      await manager.start(registry);
      expect(attempts).toBe(3);
      expect(failedAt[1]! - failedAt[0]!).toBeGreaterThanOrEqual(240);
      expect(performance.now() - failedAt[1]!).toBeGreaterThanOrEqual(990);
      expect(requests.filter(request => request.method === "server/discover")).toHaveLength(3);
      expect(requests.filter(request => request.method === "initialize")).toHaveLength(stage === "server/discover" ? 1 : 3);
      expect(manager.status(server.name)).toMatchObject({ state: "ready", toolCount: 2, error: "" });
      expect(registry.definitionsSnapshot()).toHaveLength(2);
    } finally { await manager.stop(); fetchSpy.mockRestore(); await http.stop(true); }
    expect(closes).toBe(1);
  });
}

test("HTTP 503 on a later tools/list page restarts initialization and never publishes a partial tool set", async () => {
  let initializations = 0;
  const registry = new ToolRegistry();
  const partialCounts: number[] = [];
  const http = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const message = await request.json() as WireMessage;
    if (message.method === "initialize") initializations++;
    if (message.method === "tools/list" && message.params?.cursor === "second-page" && initializations < 3) {
      partialCounts.push(registry.definitionsSnapshot().length);
      return new Response("temporary fixture overload", { status: 503 });
    }
    const reply = legacyReply(message);
    return reply ? Response.json(reply) : new Response(null, { status: 202 });
  } });
  const server = config({ url: http.url.href });
  const manager = new McpManager({ servers: [server] }, new OfficialMcpConnector({}));
  try {
    await manager.start(registry);
    expect(initializations).toBe(3);
    expect(partialCounts).toEqual([0, 0]);
    expect(manager.status(server.name)).toMatchObject({ state: "ready", toolCount: 2 });
  } finally { await manager.stop(); await http.stop(true); }
});

test("exhausted retries preserve the last actual error and unchanged step configuration does not retry", async () => {
  const failures = [new TypeError("first socket failure"), httpError(503), new TypeError("last socket failure")];
  let attempts = 0;
  const server = config();
  const manager = new McpManager({ servers: [server] }, { connect: async () => {
    const error = failures[attempts++];
    if (error) throw error;
    return connection();
  } });
  const registry = new ToolRegistry();
  try {
    await manager.start(registry);
    expect(attempts).toBe(3);
    expect(manager.status(server.name)).toMatchObject({ state: "error", error: mcpFailureText(failures[2]), toolCount: 0 });
    expect(registry.definitionsSnapshot()).toHaveLength(0);
    for (let step = 0; step < 3; step++) await manager.configure({ servers: [structuredClone(server)] });
    expect(attempts).toBe(3);
    await manager.reconnect(server.name);
    expect(attempts).toBe(4);
    expect(manager.status(server.name)).toMatchObject({ state: "ready", error: "" });
  } finally { await manager.stop(); }
});

test("each retry gets a fresh startup budget and backoff does not consume it", async () => {
  let attempts = 0;
  const server = config({ startupTimeoutMs: 100 });
  const manager = new McpManager({ servers: [server] }, { connect: async (_server, signal) => {
    await Bun.sleep(60);
    signal?.throwIfAborted();
    if (++attempts < 3) throw new TypeError("fixture transient failure");
    return connection();
  } });
  try {
    await manager.start(new ToolRegistry());
    expect(attempts).toBe(3);
    expect(manager.status(server.name).state).toBe("ready");
  } finally { await manager.stop(); }
});

for (const action of ["stop", "disable"] as const) {
  test(`${action} cancels backoff immediately without another connection attempt`, async () => {
    let attempts = 0;
    const server = config();
    const failed = Promise.withResolvers<void>();
    const manager = new McpManager({ servers: [server] }, { connect: async () => {
      attempts++;
      failed.resolve();
      throw new TypeError("fixture transient failure");
    } });
    const start = manager.start(new ToolRegistry());
    try {
      await failed.promise;
      await Bun.sleep(0); // Let the rejected attempt enter its retry delay.
      expect(manager.status(server.name).state).toBe("connecting");
      const before = performance.now();
      if (action === "stop") await manager.stop();
      else await manager.setEnabled(server.name, false);
      await start;
      expect(performance.now() - before).toBeLessThan(200);
      expect(attempts).toBe(1);
      expect(manager.status(server.name).state).toBe(action === "stop" ? "configured" : "disabled");
    } finally { await manager.stop(); }
  });
}

test("stdio, authentication, protocol errors and startup timeouts do not retry", async () => {
  const auth = new McpLoginRequired({ url: config().url }, httpError(401));
  for (const [transport, error] of [
    ["stdio", new TypeError("stdio failure")],
    ["streamable-http", auth], ["streamable-http", httpError(403)], ["streamable-http", httpError(501)],
    ["streamable-http", new ProtocolError(-32601, "actual unsupported method")],
    ["streamable-http", undefined],
  ] as const) {
    let attempts = 0;
    const server = config({ transport, startupTimeoutMs: 30 });
    const manager = new McpManager({ servers: [server] }, { connect: async () => {
      attempts++;
      if (error) throw error;
      return new Promise<McpConnection>(() => {});
    } });
    try {
      await manager.start(new ToolRegistry());
      expect(attempts).toBe(1);
      expect(manager.status(server.name).state).toBe(error === auth ? "needs_auth" : "error");
      expect(manager.status(server.name).error).toBe(error
        ? mcpFailureText(error === auth ? auth.original : error)
        : `MCP server ${server.name} startup timed out after 30ms`);
    } finally { await manager.stop(); }
  }
});
