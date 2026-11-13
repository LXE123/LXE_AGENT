import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { McpServerPreset } from "@lxe/desktop-protocol";
import { ProcessAgentRuntime } from "../../src/orchestration/process-runtime";
import { legacyReply, type WireMessage } from "../../../../packages/agent/runtime/test/tooling/protocol-mcp-server.fixture";

const roots: string[] = [], runtimes: ProcessAgentRuntime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.stop()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(presets?: McpServerPreset[]) {
  const root = mkdtempSync(join(tmpdir(), "lxe-preset-rpc-")); roots.push(root);
  const configPath = join(root, "config/mcp_servers.local.json");
  mkdirSync(join(root, "config"));
  mkdirSync(join(root, "skills"));
  const environment = { PATH: process.env.PATH, LOCAL_LOGS_ENABLED: "0", LOG_LEVEL: "ERROR", LXE_DATA_SERVER_ENABLED: "0",
    LXE_DATA_ROOT: root, LXE_MCP_CONFIG_PATH: configPath };
  const runtime = new ProcessAgentRuntime({
    command: process.execPath, arguments: [resolve("apps/agent-cli/src/main.ts")], cwd: root, environment,
    skillsRoot: join(root, "skills"), userSkillsRoot: join(root, "user-skills"), llmConfigRoot: resolve("config/llm"),
    dataRoot: root, legacyWorkspace: { directory: root, worktree: root }, ...(presets ? { mcpServerPresets: presets } : {}),
  });
  runtimes.push(runtime);
  return { runtime, root, configPath, environment };
}

test("startup and restart sync through real JSON-RPC; the independent CLI reads the same config", async () => {
  let requests = 0;
  const http = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    requests++;
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const result = legacyReply(await request.json() as WireMessage);
    return result ? Response.json(result) : new Response(null, { status: 202 });
  } });
  const preset: McpServerPreset = { name: "team-skills", enabled: true, transport: "streamable-http", url: http.url.href };
  const f = fixture([preset]);
  const other = { transport: "stdio", command: "unrelated", enabled: false };
  writeFileSync(f.configPath, JSON.stringify({ servers: { other } }));
  try {
    await f.runtime.start();
    expect(f.runtime.isReady).toBe(true);
    expect(requests).toBe(0); // Configuration synchronization never opens an MCP connection.
    const configured = await f.runtime.dashboardCall({ operation: "mcp.servers.list", input: {} });
    expect(configured.items.find(server => server.name === preset.name)).toMatchObject({ enabled: true, transport: "streamable-http" });
    const child = Bun.spawn([process.execPath, resolve("apps/agent-cli/src/main.ts"), "mcp", "list", "--json"], {
      cwd: f.root, env: f.environment, stdout: "pipe", stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code, err).toBe(0);
    expect(JSON.parse(out).servers.find((server: { name: string }) => server.name === preset.name)).toMatchObject({ state: "connected", tools: ["echo", "second"] });
    expect(requests).toBeGreaterThan(0);
    requests = 0;
    await f.runtime.dashboardCall({ operation: "mcp.servers.update", input: { name: preset.name, enabled: false } });
    const document = JSON.parse(readFileSync(f.configPath, "utf8"));
    document.servers[preset.name].url = "https://incorrect.example/mcp";
    document.servers[preset.name].headers = { "X-Custom": "retain-me" };
    writeFileSync(f.configPath, JSON.stringify(document));
    await f.runtime.restart();
    const saved = JSON.parse(readFileSync(f.configPath, "utf8"));
    expect(saved.servers[preset.name]).toEqual({ transport: preset.transport, url: preset.url, enabled: false, headers: { "X-Custom": "retain-me" } });
    expect(saved.servers.other).toEqual(other);
    expect(requests).toBe(0);
  } finally { await f.runtime.stop(); await http.stop(true); }
}, 15_000);

test("a malformed user file fails startup with its actual error and is never overwritten", async () => {
  const f = fixture([{ name: "skills", enabled: true, transport: "streamable-http", url: "https://example.com/mcp" }]);
  const contents = '{"servers":[]}';
  writeFileSync(f.configPath, contents);
  await expect(f.runtime.start()).rejects.toThrow("MCP servers must be an object");
  expect(f.runtime.isReady).toBe(false);
  expect(f.runtime.status().message).toContain("MCP servers must be an object");
  expect(readFileSync(f.configPath, "utf8")).toBe(contents);
});

test("a Harness started without desktop presets does not install product services", async () => {
  const f = fixture();
  await f.runtime.start();
  expect((await f.runtime.dashboardCall({ operation: "mcp.servers.list", input: {} })).items).toEqual([]);
  expect(existsSync(f.configPath)).toBe(false);
});
