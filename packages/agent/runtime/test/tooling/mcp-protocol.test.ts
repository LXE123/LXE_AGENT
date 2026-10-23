import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMcpHandler, Server } from "@modelcontextprotocol/server";
import { McpManager, OfficialMcpConnector, type McpProtocolMode, type McpServerConfig } from "../../src/tooling/mcp";
import { ToolRegistry } from "../../src/tooling/registry";
import { legacyReply, modernFixture, type WireMessage } from "./protocol-mcp-server.fixture";

const config = (overrides: Partial<McpServerConfig> = {}): McpServerConfig => ({
  name: "fixture", enabled: true, transport: "stdio", command: process.execPath,
  args: [], env: {}, cwd: process.cwd(), url: "", headers: {}, envHeaders: {}, bearerTokenEnvVar: "",
  connectorId: "fixture", connectorName: "Fixture", connectorDescription: "",
  startupTimeoutMs: 3_000, toolTimeoutMs: 3_000, enabledTools: new Set(), disabledTools: new Set(), exposure: "direct",
  ...overrides,
});
type Trace = { event: string; pid: number; message?: WireMessage };
const readTrace = (path: string): Trace[] => {
  try { return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
};
const eventually = async (predicate: () => boolean, timeout = 3_000) => {
  const deadline = Date.now() + timeout;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(10);
  expect(predicate()).toBe(true);
};
const exited = (pid: number) => {
  try { process.kill(pid, 0); return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return true; throw error; }
};
const stdioFixture = (mode: string, overrides: Partial<McpServerConfig> = {}) => {
  const root = mkdtempSync(join(tmpdir(), "lxe-mcp-wire-"));
  const tracePath = join(root, "wire.jsonl");
  return {
    server: config({ args: [join(import.meta.dir, "protocol-mcp-server.fixture.ts"), mode, tracePath], ...overrides }),
    trace: () => readTrace(tracePath),
    async cleanup() {
      const pids = [...new Set(readTrace(tracePath).map(entry => entry.pid))];
      await eventually(() => pids.every(exited));
      rmSync(root, { recursive: true, force: true });
    },
  };
};

for (const transport of ["stdio", "streamable-http"] as const) {
  for (const era of ["modern", "legacy"] as const) {
    for (const protocolMode of ["auto", "legacy", "2026-07-28"] as McpProtocolMode[]) {
      test(`${transport}: ${protocolMode} negotiates with ${era} wire server`, async () => {
        const recorded: WireMessage[] = [];
        const stdio = transport === "stdio" ? stdioFixture(era, { protocolMode }) : undefined;
        const handler = createMcpHandler(() => modernFixture());
        const http = transport === "streamable-http" ? Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
          if (request.method !== "POST") return new Response(null, { status: 405 });
          const message = await request.clone().json() as WireMessage;
          recorded.push(message);
          if (era === "modern") return handler.fetch(request);
          const reply = legacyReply(message);
          return reply ? Response.json(reply) : new Response(null, { status: 202 });
        } }) : undefined;
        const server = stdio?.server ?? config({ transport, protocolMode, url: `http://127.0.0.1:${http!.port}/mcp` });
        let connection;
        try {
          if (era === "legacy" && protocolMode === "2026-07-28") {
            await expect(new OfficialMcpConnector().connect(server)).rejects.toThrow();
          } else {
            connection = await new OfficialMcpConnector().connect(server);
            const expectedEra = protocolMode === "legacy" ? "legacy" : era;
            expect(connection.protocolEra).toBe(expectedEra);
            expect(connection.protocolVersion).toBe(expectedEra === "modern" ? "2026-07-28" : "2025-11-25");
            expect(connection.tools.map(tool => tool.name)).toEqual(["echo", "second"]);
            expect((await connection.callTool("echo", {})).content).toEqual([{ type: "text", text: "fixture result" }]);
          }
          const messages = stdio ? stdio.trace().flatMap(entry => entry.message ? [entry.message] : []) : recorded;
          const calls = messages.filter(message => message.method === "tools/call");
          expect(calls).toHaveLength(era === "legacy" && protocolMode === "2026-07-28" ? 0 : 1);
          if (era === "modern" && protocolMode !== "legacy") {
            expect(messages.some(message => message.method === "server/discover")).toBe(true);
            expect(messages.some(message => message.method === "initialize")).toBe(false);
            expect(calls[0]?.params?._meta?.["io.modelcontextprotocol/protocolVersion"]).toBe("2026-07-28");
          } else if (protocolMode !== "2026-07-28") {
            expect(messages.some(message => message.method === "initialize")).toBe(true);
            expect(messages.some(message => message.method === "server/discover")).toBe(protocolMode === "auto");
          }
          if (connection) expect(messages.filter(message => message.method === "tools/list")).toHaveLength(2);
        } finally {
          await connection?.close();
          await handler.close();
          await http?.stop(true);
          await stdio?.cleanup();
        }
      });
    }
  }
}

test("modern structured results preserve every JSON value and the connection survives tool cancellation", async () => {
  const fixture = stdioFixture("modern");
  const connection = await new OfficialMcpConnector().connect(fixture.server);
  try {
    for (const value of [null, false, 0, "", [], {}, [1, { name: "test" }]]) {
      expect((await connection.callTool("echo", { value })).structuredContent).toEqual(value);
    }
    const abort = new AbortController();
    const pending = connection.callTool("echo", { hang: true }, abort.signal);
    const observed = pending.then(() => undefined, error => error);
    await eventually(() => fixture.trace().some(entry => entry.message?.params?.arguments?.hang));
    abort.abort(new Error("fixture turn cancelled"));
    expect(String(await observed)).toContain("fixture turn cancelled");
    await eventually(() => fixture.trace().some(entry => entry.event === "cancelled"));
    expect((await connection.callTool("echo", {})).isError).toBe(false);
  } finally { await connection.close(); await fixture.cleanup(); }
});

test("HTTP cancellation closes a modern request without repeating the tool call", async () => {
  let cancelled = false;
  const calls: WireMessage[] = [];
  const handler = createMcpHandler(() => modernFixture(() => { cancelled = true; }));
  const http = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (request.method === "POST") calls.push(await request.clone().json() as WireMessage);
    return handler.fetch(request);
  } });
  let connection;
  try {
    connection = await new OfficialMcpConnector().connect(config({ transport: "streamable-http", url: `http://127.0.0.1:${http.port}/mcp` }));
    const abort = new AbortController();
    const observed = connection.callTool("echo", { hang: true }, abort.signal).then(() => undefined, error => error);
    await eventually(() => calls.some(call => call.params?.arguments?.hang));
    abort.abort(new Error("fixture HTTP turn cancelled"));
    expect(String(await observed)).toContain("fixture HTTP turn cancelled");
    await eventually(() => cancelled);
    expect(calls.filter(call => call.params?.arguments?.hang)).toHaveLength(1);
    expect((await connection.callTool("echo", {})).isError).toBe(false);
  } finally { await connection?.close(); await handler.close(); await http.stop(true); }
});

test("SDK validates modern JSON Schema array outputs and retains validation failures", async () => {
  const handler = createMcpHandler(() => {
    const server = new Server({ name: "schema-fixture", version: "1" }, { capabilities: { tools: {} } });
    server.setRequestHandler("tools/list", async () => ({ tools: [{
      name: "array", inputSchema: { type: "object" },
      outputSchema: { type: "array", prefixItems: [{ type: "number" }], items: false },
    }] }));
    server.setRequestHandler("tools/call", async request => ({ content: [], structuredContent: request.params.arguments?.value }));
    return server;
  });
  const http = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => handler.fetch(request) });
  let connection;
  try {
    connection = await new OfficialMcpConnector().connect(config({ transport: "streamable-http", url: `http://127.0.0.1:${http.port}/mcp` }));
    expect((await connection.callTool("array", { value: [1] })).structuredContent).toEqual([1]);
    await expect(connection.callTool("array", { value: ["wrong type"] })).rejects.toThrow("number");
  } finally { await connection?.close(); await handler.close(); await http.stop(true); }
});

test("disabling and stopping established stdio connections removes tools and reaps both children", async () => {
  const fixture = stdioFixture("modern");
  const manager = new McpManager({ servers: [fixture.server] });
  const registry = new ToolRegistry();
  try {
    await manager.start(registry);
    expect(registry.schemas()).toHaveLength(2);
    await manager.setEnabled("fixture", false);
    expect(registry.schemas()).toEqual([]);
    await eventually(() => fixture.trace().every(entry => exited(entry.pid)));
    await manager.setEnabled("fixture", true);
    expect(registry.schemas()).toHaveLength(2);
    await manager.stop();
    expect(registry.schemas()).toEqual([]);
    expect(manager.status("fixture").connected).toBe(false);
  } finally { await manager.stop(); await fixture.cleanup(); }
});

for (const mode of ["exit-on-probe", "exit-on-call"]) {
  test(`stdio handles ${mode} without leaving a child`, async () => {
    const fixture = stdioFixture(mode);
    const connection = await new OfficialMcpConnector().connect(fixture.server);
    try {
      expect(connection.protocolEra).toBe("legacy");
      if (mode === "exit-on-call") await expect(connection.callTool("echo", {})).rejects.toThrow();
      else expect((await connection.callTool("echo", {})).isError).toBe(false);
    } finally { await connection.close(); await fixture.cleanup(); }
  });
}

for (const action of ["timeout", "disable", "stop"] as const) {
  test(`manager ${action} cancels an unfinished stdio connection and reaps probe children`, async () => {
    const fixture = stdioFixture("silent", { startupTimeoutMs: 400 });
    const manager = new McpManager({ servers: [fixture.server] });
    const registry = new ToolRegistry();
    try {
      const started = manager.start(registry);
      await eventually(() => fixture.trace().some(entry => entry.message?.method === "server/discover"));
      if (action === "disable") await manager.setEnabled("fixture", false);
      if (action === "stop") await manager.stop();
      await started;
      expect(manager.status("fixture").connected).toBe(false);
      expect(registry.schemas()).toEqual([]);
      if (action === "timeout") expect(manager.status("fixture").error).toContain("timed out");
      else {
        // Wait beyond the sibling's probe budget: a closed Client alone used
        // to start a new session child after the manager had already stopped.
        await Bun.sleep(fixture.server.startupTimeoutMs);
        expect(fixture.trace().filter(entry => entry.event === "spawn")).toHaveLength(1);
      }
    } finally { await manager.stop(); await fixture.cleanup(); }
  });
}

for (const status of [401, 403, 500]) {
  test(`HTTP ${status} during negotiation reports the error and does not fall back`, async () => {
    const methods: string[] = [];
    const http = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      methods.push((await request.json() as WireMessage).method!);
      return new Response(`actual fixture failure ${status}`, { status });
    } });
    try {
      let failure: unknown;
      try { await new OfficialMcpConnector().connect(config({ transport: "streamable-http", url: `http://127.0.0.1:${http.port}/mcp` })); }
      catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).toContain(String(status));
      expect(methods).toEqual(["server/discover"]);
    } finally { await http.stop(true); }
  });
}

test("malformed HTTP discovery stays a protocol failure instead of an empty tool list", async () => {
  const methods: string[] = [];
  const http = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    methods.push((await request.json() as WireMessage).method!);
    return new Response("invalid JSON from fixture", { headers: { "Content-Type": "application/json" } });
  } });
  try {
    await expect(new OfficialMcpConnector().connect(config({ transport: "streamable-http", url: `http://127.0.0.1:${http.port}/mcp` }))).rejects.toThrow();
    expect(methods).toEqual(["server/discover"]);
  } finally { await http.stop(true); }
});
