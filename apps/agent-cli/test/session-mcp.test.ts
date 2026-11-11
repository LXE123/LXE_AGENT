import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMcpConfig, SqliteRuntimeStore, ToolRegistry } from "@lxe/runtime";
import { McpAccess } from "../src/mcp-access";
import { McpAuthStore } from "../src/mcp-auth-store";
import { registerMcpDiscoveryTools } from "../src/mcp-discovery";
import { SessionMcpPool, sessionMcpConfig } from "../src/session-mcp";
import { AgentRunHandle } from "../src/run-handle";

test("session leases isolate cwd, registry, codemode and discovery; reuse one initialization and rebuild after release", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "session-mcp-")));
  const a = join(root, "a"), b = join(root, "b");
  for (const dir of [a, b]) mkdirSync(dir);
  const configPath = join(root, "mcp.json");
  writeFileSync(configPath, JSON.stringify({ servers: { local: { enabled: true, command: process.execPath,
    args: [join(import.meta.dir, "../../../packages/agent/runtime/test/tooling/session-mcp.fixture.ts")], cwd: ".", exposure: "deferred" } } }));
  const config = loadMcpConfig(configPath, {});
  config.servers.push({ ...config.servers[0]!, name: "catalog", exposure: "codemode" });
  const store = new SqliteRuntimeStore(join(root, "agent.sqlite3"));
  await store.start();
  let starts = 0;
  const pool = new SessionMcpPool(async (directory, platform) => {
    starts++;
    const scoped = sessionMcpConfig(config, directory, platform), tools = new ToolRegistry();
    const access = new McpAccess(scoped, new McpAuthStore(root), process.env);
    registerMcpDiscoveryTools(tools, scoped, store);
    return { config: scoped, tools, access };
  });
  const context = (id: string, directory: string) => ({ session_id: id, turn_id: "turn", tool_call_id: "call",
    platform: "cli", handle: new AgentRunHandle(), workspace: { directory, worktree: directory },
    executionPolicy: { mode: "danger-full-access" as const, workspaceRoot: directory, sessionId: id },
  });
  try {
    for (const [id, directory] of [["A", a], ["B", b], ["C", a]]) await store.ensureSession({ session_id: id!, source: { platform: "cli" }, workspace: { directory: directory!, worktree: directory! } });
    const [first, duplicate, second, sameWorkspace] = await Promise.all([
      pool.acquire("A", a, "cli"), pool.acquire("A", a, "cli"), pool.acquire("B", b, "cli"), pool.acquire("C", a, "cli"),
    ]);
    expect(starts).toBe(3);
    expect(first.access).toBe(duplicate.access);
    expect(first.tools).not.toBe(second.tools);
    expect(first.access).not.toBe(sameWorkspace.access);
    expect(config.servers[0]!.cwd).toBe(".");
    const read = async (lease: typeof first, id: string, directory: string) => {
      const exposure = lease.tools.createExposureState({ platform: "cli" });
      const ctx = { ...context(id, directory), exposureState: exposure };
      const result = await lease.tools.execute("codemode", { code: 'const hits = await searchTools("workspace identity"); text(JSON.parse((await tools[hits[0].name]({})).content[0].text));' }, ctx);
      const output = JSON.parse((result.content[0] as { text: string }).text) as { cwd: string; pid: number };
      expect(output.cwd).toBe(directory);
      const hits = await lease.tools.execute("tool_search", { query: "workspace identity" }, ctx);
      expect(JSON.stringify(hits)).toContain("mcp__local__where");
      expect(exposure.schemas().some(t => t.name === "mcp__local__where")).toBe(true);
      const direct = await lease.tools.execute("mcp__local__where", {}, ctx);
      return JSON.parse((direct.content[0] as { text: string }).text) as { cwd: string; pid: number };
    };
    const left = await read(first, "A", a), right = await read(second, "B", b);
    expect(left.cwd).toBe(a); expect(right.cwd).toBe(b); expect(left.pid).not.toBe(right.pid);
    expect(first.access.manager.status("local").state).toBe("ready");
    second.release();
    await pool.dispose("B");
    expect(await read(first, "A", a)).toEqual(left);
    const rebuilt = await pool.acquire("B", b, "cli");
    expect((await read(rebuilt, "B", b)).pid).not.toBe(right.pid);
    // A configuration refresh affects only the session applying it.
    const disabled = sessionMcpConfig(config, a, "cli"); disabled.servers[0]!.enabled = false;
    await first.access.configure(disabled);
    expect(first.tools.definition("mcp__local__where")).toBeUndefined();
    expect(rebuilt.tools.definition("mcp__local__where")).toBeDefined();
    first.release(); duplicate.release(); sameWorkspace.release(); rebuilt.release();
  } finally { await pool.stop(); await store.stop(); rmSync(root, { recursive: true, force: true }); }
}, 20_000);

test("idle recycling waits for every turn/login lease and cancels its timer on reuse", async () => {
  let starts = 0, stops = 0;
  const errors: unknown[] = [];
  const pool = new SessionMcpPool(async () => {
    starts++;
    return { tools: new ToolRegistry(), config: { servers: [] }, access: {
      stop() {}, manager: { async start() {}, async stop() { stops++; } },
    } as unknown as McpAccess };
  }, 40, error => errors.push(error));
  try {
    const turn = await pool.acquire("A", "/workspace", "cli");
    const login = await pool.acquire("A", "/workspace", "cli");
    turn.release(); turn.release();
    await Bun.sleep(70);
    expect(stops).toBe(0);
    login.release();
    const reused = await pool.acquire("A", "/workspace", "cli");
    await Bun.sleep(70);
    expect(starts).toBe(1); expect(stops).toBe(0);
    reused.release();
    await Bun.sleep(70);
    expect(stops).toBe(1);
    const rebuilt = await pool.acquire("A", "/workspace", "cli");
    expect(starts).toBe(2);
    await pool.stop();
    expect(stops).toBe(2);
    rebuilt.release();
    expect(errors).toEqual([]);
  } finally { await pool.stop(); }
});

test("cwd resolution is local to stdio sessions and platform-only services stay out of other chats", () => {
  const project = join(tmpdir(), "project"), fixed = join(tmpdir(), "fixed");
  const config = { servers: [
    { name: "default", transport: "stdio", cwd: "" }, { name: "relative", transport: "stdio", cwd: "sub" },
    { name: "absolute", transport: "stdio", cwd: fixed }, { name: "remote", transport: "streamable-http", cwd: "" },
    { name: "desktop", transport: "stdio", cwd: "", platforms: ["desktop"] },
  ] } as unknown as Parameters<typeof sessionMcpConfig>[0];
  expect(sessionMcpConfig(config, project, "cli").servers.map(s => [s.name, s.cwd])).toEqual([
    ["default", project], ["relative", join(project, "sub")], ["absolute", fixed], ["remote", ""],
  ]);
  expect(config.servers[0]!.cwd).toBe("");
});

test("shutdown cancels initialization instead of waiting for its timeout", async () => {
  const starting = Promise.withResolvers<void>(), ended = Promise.withResolvers<void>();
  let stopped = false;
  const pool = new SessionMcpPool(() => ({ tools: new ToolRegistry(), config: { servers: [] }, access: {
    stop() {}, manager: {
      async start() { starting.resolve(); await ended.promise; },
      async stop() { stopped = true; ended.resolve(); },
    },
  } as unknown as McpAccess }));
  const acquisition = pool.acquire("A", "/workspace", "cli").catch(error => error as Error);
  await starting.promise;
  await pool.stop();
  expect(await acquisition).toBeInstanceOf(Error);
  expect((await acquisition as Error).message).toContain("released");
  expect(stopped).toBe(true);
});
