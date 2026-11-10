import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { repositoryRoot, resolveWorkspaceContext } from "@lxe/core";
import { addMcpServer, loadMcpConfig } from "@lxe/runtime";
import { createAgentRuntimeHost } from "../src/runtime-host";
import { legacyReply, type WireMessage } from "../../../packages/agent/runtime/test/tooling/protocol-mcp-server.fixture";

test("adding a service preserves aliases, unrelated settings and literal environment references", () => {
  const root = mkdtempSync(join(tmpdir(), "mcp-add-config-"));
  const path = join(root, "mcp.json");
  try {
    const original = { labels: ["custom"], mcpServers: { docs: { command: "docs", enabled: false, extra: 1 } } };
    writeFileSync(path, JSON.stringify(original));
    const definition = { transport: "stdio", command: "node", env: { TOKEN: "${TOKEN}" } };
    expect(() => addMcpServer(path, "local", definition, {}, root)).toThrow("missing environment variable TOKEN");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(original);
    addMcpServer(path, "local", definition, { TOKEN: "resolved-secret" }, root);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ ...original, mcpServers: {
      ...original.mcpServers, local: { ...definition, enabled: true, exposure: "codemode" },
    } });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("saving both transports connects and discovers tools in the same running host", async () => {
  const source = repositoryRoot(import.meta.dir);
  const root = mkdtempSync(join(tmpdir(), "mcp-add-host-"));
  const trace = join(root, "spawn.jsonl");
  const requests: Array<string | null> = [];
  const http = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    requests.push(request.headers.get("Authorization"));
    const reply = legacyReply(await request.json() as WireMessage);
    return reply ? Response.json(reply) : new Response(null, { status: 202 });
  } });
  const config = join(root, "config");
  mkdirSync(config);
  writeFileSync(join(config, "auth.json"), JSON.stringify({ zhipuai: { type: "api_key", key: "fixture" } }));
  const open = () => createAgentRuntimeHost({ dataRoot: root, legacyWorkspace: resolveWorkspaceContext(root),
    skillsRoot: root, userSkillsRoot: join(root, "user-skills"), llmConfigRoot: join(source, "config/llm"),
    environment: { MCP_TEST_TOKEN: "fixture-token", AGENT_LLM_PROVIDER: "zhipuai", LOCAL_LOGS_ENABLED: "0", LXE_DATA_SERVER_ENABLED: "0" },
    emitter: { emit: async () => {}, typing: async () => {} },
  });
  const host = open();
  const list = () => host.dashboardCall({ operation: "mcp.servers.list", input: {} });
  try {
    await host.start();
    expect((await list()).total).toBe(0);
    const local = { name: "local", transport: "stdio" as const, command: process.execPath,
      args: [join(source, "packages/agent/runtime/test/tooling/protocol-mcp-server.fixture.ts"), "modern", trace] };
    await host.dashboardCall({ operation: "mcp.servers.add", input: local });
    const remote = { name: "team-skills", transport: "streamable-http" as const, url: http.url.href, bearer_token_env_var: "MCP_TEST_TOKEN" };
    await host.dashboardCall({ operation: "mcp.servers.add", input: remote });
    await expect(host.dashboardCall({ operation: "mcp.servers.add", input: { ...remote, name: "team_skills" } })).rejects.toThrow("mcp__team_skills");
    await host.dashboardCall({ operation: "mcp.servers.add", input: { ...remote, name: "missing", bearer_token_env_var: "UNSET_TOKEN" } });
    await expect(host.dashboardCall({ operation: "mcp.servers.add", input: { ...local, name: "lxe_desktop" } })).rejects.toThrow("reserved");
    await expect(host.dashboardCall({ operation: "mcp.servers.add", input: { ...local, name: "lxe-desktop" } })).rejects.toThrow("reserved");
    await expect(host.dashboardCall({ operation: "mcp.servers.add", input: local })).rejects.toThrow("already exists");
    const saved = await list();
    expect(saved.total).toBe(3);
    expect(JSON.stringify(saved)).not.toContain("fixture-token");
    const deadline = Date.now() + 5_000;
    while ((await list()).items.some(item => item.status === "connecting") && Date.now() < deadline) await Bun.sleep(10);
    const live = (await list()).items;
    for (const name of ["local", "team-skills"]) {
      expect(live.find(item => item.name === name)).toMatchObject({ status: "ready", tool_count: 2, exposure: "codemode" });
    }
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every(header => header === "Bearer fixture-token")).toBe(true);
    expect(existsSync(trace)).toBe(true);
    expect(live.find(item => item.name === "missing")?.error).toContain("missing environment variable UNSET_TOKEN");
  } finally {
    await host.stop();
    http.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
});

test("a namespace collision in user configuration is reported without overwriting the first server", () => {
  const root = mkdtempSync(join(tmpdir(), "mcp-names-"));
  const path = join(root, "mcp.json");
  const definition = { command: "node" };
  try {
    addMcpServer(path, "team-skills", definition, {}, root);
    const before = readFileSync(path, "utf8");
    expect(() => addMcpServer(path, "team_skills", definition, {}, root)).toThrow("share the model namespace");
    expect(readFileSync(path, "utf8")).toBe(before);
    writeFileSync(path, JSON.stringify({ servers: { "team-skills": definition, team_skills: definition } }));
    expect(() => loadMcpConfig(path, {})).toThrow("mcp__team_skills");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
