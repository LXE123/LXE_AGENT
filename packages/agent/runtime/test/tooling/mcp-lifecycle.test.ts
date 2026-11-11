import { expect, test } from "bun:test";
import { McpManager, type McpConnection, type McpServerConfig } from "../../src/tooling/mcp";
import { ToolRegistry } from "../../src/tooling/registry";
import { policyFor, testWorkspace } from "../workspace";

const server = (name = "fixture", overrides: Partial<McpServerConfig> = {}): McpServerConfig => ({
  name, enabled: true, transport: "stdio", command: "fixture", args: [], env: {}, cwd: "", url: "",
  headers: {}, envHeaders: {}, bearerTokenEnvVar: "", connectorId: name, connectorName: name, connectorDescription: "",
  startupTimeoutMs: 1_000, toolTimeoutMs: 1_000, enabledTools: new Set(), disabledTools: new Set(), exposure: "deferred",
  ...overrides,
});
const context = () => ({
  session_id: "s1", workspace: testWorkspace, executionPolicy: policyFor(testWorkspace.directory),
  handle: { signal: new AbortController().signal, cancelled: false, drainSteering: () => [], registerProcess: () => () => {} },
});
function connection(names = ["echo"]) {
  let listener = () => {};
  const calls: string[] = [];
  let closes = 0;
  const value: McpConnection = {
    tools: names.map(name => ({ name })),
    onClose(callback) { listener = callback; return () => {}; },
    callTool: async name => { calls.push(name); return { content: [{ type: "text", text: name }], isError: false }; },
    close: async () => { closes++; listener(); },
  };
  // Intentionally retains the listener after unsubscribe to simulate an already queued old callback.
  return { value, disconnect: () => listener(), calls, closes: () => closes };
}

test("config refresh preserves unchanged connections and failures, replaces only changed services and frees removed namespaces", async () => {
  const calls: string[] = [], closed: string[] = [];
  const config = { servers: [server("stable"), server("failed")] };
  const manager = new McpManager(structuredClone(config), { connect: async entry => {
    calls.push(entry.name);
    if (entry.name === "failed") throw new Error("fixture startup failure");
    const result = connection().value;
    return { ...result, close: async () => { closed.push(entry.name); await result.close(); } };
  } });
  const tools = new ToolRegistry();
  try {
    await manager.start(tools);
    const stable = tools.definition("mcp__stable__echo");
    for (let step = 0; step < 3; step++) await manager.configure(structuredClone(config));
    expect(calls).toEqual(["stable", "failed"]);
    expect(manager.status("failed").error).toContain("fixture startup failure");
    expect(tools.definition("mcp__stable__echo")).toBe(stable);
    await manager.configure({ servers: [...config.servers, server("new-service")] });
    expect(calls).toEqual(["stable", "failed", "new-service"]);
    await manager.configure({ servers: [server("stable", { enabled: false }), server("new_service")] });
    expect(closed.sort()).toEqual(["new-service", "stable"]);
    expect(tools.definition("mcp__stable__echo")).toBeUndefined();
    expect(tools.definition("mcp__new_service__echo")).toBeDefined();
    expect(manager.status("stable").state).toBe("disabled");
  } finally { await manager.stop(); }
});

test("passive disconnect removes owned tools; only explicit reconnect discovers a replacement", async () => {
  const first = connection(["before"]), second = connection(["after"]);
  first.value.instructions = "First connection";
  second.value.instructions = "Replacement connection";
  let attempts = 0;
  const manager = new McpManager({ servers: [server()] }, { connect: async () => ++attempts === 1 ? first.value : second.value });
  const registry = new ToolRegistry();
  registry.register({ name: "native", description: "", input_schema: {}, execute: async () => ({ content: [] }) });
  expect(manager.status("fixture").state).toBe("configured");
  try {
    await manager.start(registry);
    const staleTool = registry.definition("mcp__fixture__before")!;
    expect(manager.status("fixture").state).toBe("ready");
    expect(manager.serverInstructions("fixture")).toBe("First connection");
    first.disconnect();
    expect(manager.serverInstructions("fixture")).toBeUndefined();
    expect(manager.status("fixture")).toMatchObject({ state: "disconnected", connected: false, toolCount: 0, tools: [] });
    expect(registry.schemas().map(tool => tool.name)).toEqual(["native"]);
    expect(attempts).toBe(1);
    await manager.reconnect("fixture");
    first.disconnect();
    expect(manager.status("fixture")).toMatchObject({ state: "ready", toolCount: 1 });
    expect(manager.serverInstructions("fixture")).toBe("Replacement connection");
    expect(registry.schemas().map(tool => tool.name)).toEqual(["native", "mcp__fixture__after"]);
    await expect(staleTool.execute({}, context())).rejects.toThrow("no longer active");
    expect(first.calls).toEqual([]);
    await registry.execute("mcp__fixture__after", {}, context());
    expect(second.calls).toEqual(["after"]);
    await manager.setEnabled("fixture", false);
    await expect(manager.reconnect("fixture")).rejects.toThrow("disabled");
    expect(manager.status("fixture").state).toBe("disabled");
  } finally { await manager.stop(); }
  expect(second.closes()).toBe(1);
});

test("reconnect cancels an in-flight startup and closes a late result without replacing new tools", async () => {
  const late = connection(["old"]), next = connection(["new"]);
  const pending = Promise.withResolvers<McpConnection>();
  let attempts = 0;
  const manager = new McpManager({ servers: [server()] }, { connect: async () => ++attempts === 1 ? pending.promise : next.value });
  const registry = new ToolRegistry();
  const started = manager.start(registry);
  await Bun.sleep(0);
  expect(attempts).toBe(1);
  expect(manager.status("fixture").state).toBe("connecting");
  try {
    await manager.reconnect("fixture");
    await started;
    pending.resolve(late.value);
    await Bun.sleep(0);
    expect(late.closes()).toBe(1);
    expect(manager.status("fixture")).toMatchObject({ state: "ready", tools: [{ rawName: "new", modelName: "mcp__fixture__new" }] });
    expect(registry.schemas().map(tool => tool.name)).toEqual(["mcp__fixture__new"]);
  } finally { pending.resolve(late.value); await manager.stop(); }
});

test("disable wins over reconnect while the previous connection is closing", async () => {
  const closing = Promise.withResolvers<void>();
  let attempts = 0;
  const manager = new McpManager({ servers: [server()] }, { connect: async () => {
    attempts++;
    return { ...connection().value, close: () => closing.promise };
  } });
  const registry = new ToolRegistry();
  await manager.start(registry);
  const retry = manager.reconnect("fixture");
  const disabled = manager.setEnabled("fixture", false);
  closing.resolve();
  await Promise.all([retry, disabled]);
  expect(attempts).toBe(1);
  expect(manager.status("fixture").state).toBe("disabled");
  expect(registry.schemas()).toEqual([]);
  await manager.stop();
});

test("long and colliding normalized server names clean up only their own registrations", async () => {
  const servers = [server("a__b"), server("a_b"), server("long".repeat(30))];
  const clients = servers.map(() => connection(["a.b", "a/b"]));
  const manager = new McpManager({ servers }, { connect: async item => clients[servers.indexOf(item)]!.value });
  const registry = new ToolRegistry();
  try {
    await manager.start(registry);
    const names = registry.schemas().map(tool => tool.name);
    expect(new Set(names).size).toBe(6);
    expect(names.every(name => name.length <= 64 && /^[A-Za-z0-9_-]+$/.test(name))).toBe(true);
    for (const tool of registry.definitionsSnapshot()) await registry.execute(tool.name, {}, context());
    expect(clients.map(client => client.calls)).toEqual(servers.map(() => ["a.b", "a/b"]));
    const remaining = manager.status("a_b").tools.map(tool => tool.modelName);
    await manager.setEnabled("a__b", false);
    await manager.setEnabled(servers[2]!.name, false);
    expect(registry.schemas().map(tool => tool.name)).toEqual(remaining);
  } finally { await manager.stop(); }
});

test("business failures retain diagnostics without declaring the transport disconnected", async () => {
  const manager = new McpManager({ servers: [server()] }, { connect: async () => ({
    ...connection().value,
    callTool: async () => ({ content: [{ type: "text", text: "actual input rejected" }], isError: true }),
  }) });
  const registry = new ToolRegistry();
  try {
    await manager.start(registry);
    await expect(registry.execute("mcp__fixture__echo", {}, context())).rejects.toThrow("actual input rejected");
    expect(manager.status("fixture")).toMatchObject({ state: "ready", connected: true, error: "actual input rejected", toolCount: 1 });
  } finally { await manager.stop(); }
});

test("failed discovery can be retried; shutdown is bounded even when one close hangs", async () => {
  let attempts = 0;
  const other = connection();
  const manager = new McpManager({ servers: [server(), server("other")] }, { connect: async item => {
    if (item.name === "other") return other.value;
    if (++attempts === 1) throw new Error("actual startup rejection");
    return { ...connection().value, close: () => new Promise(() => {}) };
  } }, 10);
  const registry = new ToolRegistry();
  await manager.start(registry);
  expect(manager.status("fixture")).toMatchObject({ state: "error", error: "actual startup rejection" });
  await manager.reconnect("fixture");
  expect(manager.status("fixture")).toMatchObject({ state: "ready", error: "" });
  await manager.stop();
  expect(other.closes()).toBe(1);
  expect(registry.schemas()).toEqual([]);
  expect(manager.status("fixture")).toMatchObject({ state: "configured", connected: false });
});

test("a connection already closed at subscription never publishes stale tools", async () => {
  const manager = new McpManager({ servers: [server()] }, { connect: async () => ({
    ...connection().value, onClose: listener => { listener(); return () => {}; },
  }) });
  const registry = new ToolRegistry();
  try {
    await manager.start(registry);
    expect(manager.status("fixture").state).toBe("disconnected");
    expect(registry.schemas()).toEqual([]);
  } finally { await manager.stop(); }
});

test("invalid duplicate remote names fail without leaving a partial tool registration", async () => {
  const client = connection(["echo", "echo"]);
  const manager = new McpManager({ servers: [server()] }, { connect: async () => client.value });
  const registry = new ToolRegistry();
  await manager.start(registry);
  expect(manager.status("fixture")).toMatchObject({ state: "error", connected: false, tools: [] });
  expect(manager.status("fixture").error).toContain("duplicate MCP tool name");
  expect(registry.schemas()).toEqual([]);
  expect(client.closes()).toBe(1);
  await manager.stop();
});
