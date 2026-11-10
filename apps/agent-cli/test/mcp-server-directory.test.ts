import { expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repositoryRoot, resolveWorkspaceContext } from "@lxe/core";
import type { McpServerConfig } from "@lxe/runtime";
import { takeDesktopMcpConfig } from "../src/desktop-mcp";
import { renderMcpServerDirectory } from "../src/mcp-server-directory";
import { AgentRunHandle } from "../src/run-handle";
import { createAgentRuntimeHost } from "../src/runtime-host";

import { legacyReply, type WireMessage } from "../../../packages/agent/runtime/test/tooling/protocol-mcp-server.fixture";

const source = repositoryRoot(import.meta.dir);
const desktopEnv = {
  LXE_DESKTOP_MCP_COMMAND: process.execPath,
  LXE_DESKTOP_MCP_SCRIPT: join(source, "packages/agent/runtime/test/tooling/protocol-mcp-server.fixture.ts"),
  LXE_DESKTOP_MCP_PIPE: "test-pipe", LXE_DESKTOP_MCP_TOKEN: "test-token",
};
const desktop = takeDesktopMcpConfig({ ...desktopEnv })!;
const server = (name: string, options: Partial<McpServerConfig> = {}): McpServerConfig => ({
  ...desktop, name, connectorDescription: "", ...options,
});

test("directory uses one line per visible indirect server and bounds model-facing text", () => {
  const config = { servers: [
    server("z", { connectorDescription: "Configured\nsecond line" }), server("a", { exposure: "deferred" }),
    server("b"), server("direct", { exposure: "direct" }), server("hidden", { exposure: "hidden" }),
    server("disabled", { enabled: false }),
  ] };
  const manager = { serverInstructions: (name: string) => name === "b" ? undefined : "Live instructions\r\nextra detail" };
  const lines = renderMcpServerDirectory(config, "desktop", manager).split("\n");
  expect(lines.filter(line => line.startsWith("-"))).toEqual([
    "- mcp__a (tool_search): Live instructions", "- mcp__b (codemode)", "- mcp__z (codemode): Configured",
  ]);
  expect(renderMcpServerDirectory(config, "cli", manager)).toBe("");
  const long = server("long", { connectorDescription: "好".repeat(400) });
  expect(renderMcpServerDirectory({ servers: [long] }, "desktop", manager)).toEndWith("好".repeat(249) + "…");
  const many = { servers: Array.from({ length: 250 }, (_, i) => ({ ...long, name: `test-server-${i}` })) };
  const directory = renderMcpServerDirectory(many, "desktop", manager);
  const listed = directory.split("\n").filter(line => line.startsWith("- ")).length;
  expect(listed).toBeGreaterThan(0);
  expect(listed).toBeLessThan(many.servers.length);
  expect(directory).toEndWith(`… ${many.servers.length - listed} more MCP servers`);
  expect(directory.length).toBeLessThanOrEqual(4096);
});

test("desktop and CLI turns send platform-scoped MCP directories to the model", async () => {
  type WireRequest = { messages: Array<{ role: string; content: string }>; tools?: Array<{ function: { name: string; description: string } }> };
  const received: WireRequest[] = [];
  const endpoint = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const body = await request.json() as WireRequest;
      if (body.tools?.length) received.push(body);
      const chunk = { id: "test", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    },
  });
  const protectedServer = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (request.headers.get("Authorization") !== "Bearer oauth-fixture") return new Response("Sign in first", {
      status: 401, headers: { "WWW-Authenticate": 'Bearer scope="orders.read"' },
    });
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const reply = legacyReply(await request.json() as WireMessage);
    return reply ? Response.json(reply) : new Response(null, { status: 202 });
  } });
  const root = mkdtempSync(join(tmpdir(), "lxe-mcp-prompt-"));
  const llmConfigRoot = join(root, "config/llm");
  cpSync(join(source, "config/llm"), llmConfigRoot, { recursive: true });
  const providerFile = join(llmConfigRoot, "providers/zhipuai.json");
  const provider = JSON.parse(readFileSync(providerFile, "utf8"));
  writeFileSync(providerFile, JSON.stringify({ ...provider, base_url: endpoint.url.origin }));
  writeFileSync(join(root, "config/auth.json"), JSON.stringify({ zhipuai: { type: "api_key", key: "fixture" } }));
  writeFileSync(join(root, "config/mcp_servers.local.json"), JSON.stringify({ servers: { orders: {
    command: process.execPath, args: [desktopEnv.LXE_DESKTOP_MCP_SCRIPT], exposure: "deferred", connector_description: "查询订单",
  } } }));
  const skillsRoot = join(root, "skills");
  mkdirSync(skillsRoot);
  const workspace = resolveWorkspaceContext(root);
  const host = createAgentRuntimeHost({
    dataRoot: root, legacyWorkspace: workspace, skillsRoot, userSkillsRoot: join(root, "user-skills"), llmConfigRoot,
    environment: { ...desktopEnv, AGENT_LLM_PROVIDER: "zhipuai", LOCAL_LOGS_ENABLED: "0", LXE_DATA_SERVER_ENABLED: "0" },
    emitter: { emit: async () => {}, typing: async () => {} },
  });
  async function turn(session: string, platform: string) {
    const id = crypto.randomUUID();
    const before = received.length;
    const result = await host.runTurn({ job_id: id, session_id: session, session_key: session, response_route_id: id,
      user_id: "tester", conversation_id: session, is_group: false, message_id: id, job_kind: "turn", sender_nick: "test",
      source: { platform }, user_input: "hello", raw_data: {}, user_content_blocks: [], diagnostics: [], workspace }, new AgentRunHandle());
    expect(result).toMatchObject({ status: "completed", reply: "ok" });
    expect(received).toHaveLength(before + 1);
    const request = received[before]!;
    expect(request.messages[0]?.role).toBe("system");
    const descriptions = new Map(request.tools!.map(({ function: tool }) => [tool.name, tool.description]));
    for (const name of ["grep", "find", "ls"]) expect(descriptions.has(name)).toBe(false);
    expect(request.messages[0]!.content).toContain("Use exec to list directories, find files, and search their contents.");
    return { prompt: request.messages[0]!.content, tools: [...descriptions.keys()], descriptions };
  }
  try {
    await host.start();
    for (const platform of ["desktop", "cli"]) await host.ensureSession({ session_id: platform, source: { platform }, workspace });
    const first = await turn("desktop", "desktop");
    // A fresh desktop turn has the harness schemas only; the MCP tools are indirect.
    expect(JSON.stringify(received[0]!.tools)).not.toMatch(/\p{Script=Han}/u);
    expect(first.prompt).toContain("- mcp__lxe_desktop (codemode): Manage scheduled tasks in the desktop app.");
    expect(first.prompt).toContain("batch independent tool calls with Promise.allSettled, chain dependent calls in order, or filter large results");
    for (const name of ["write", "edit"]) {
      expect(first.descriptions.get(name)).toEndWith(`Codemode: \`tools.${name}(args)\` resolves to a string.`);
    }
    const readSuffix = first.descriptions.get("read")!.split("\n\nCodemode: ").at(-1)!;
    expect(readSuffix).toContain("`tools.read(args)` resolves to `string |");
    expect(readSuffix).toContain('type: "image"');
    expect(first.descriptions.get("exec")).toContain("`tools.exec(args)` resolves to `{ status, exec_id, output,");
    expect(first.descriptions.get("wait")).toContain("`tools.wait(args)` resolves to `{ status, exec_id, new_output,");
    expect(first.tools.filter(name => first.descriptions.get(name)!.includes("\n\nCodemode: ")).sort())
      .toEqual(["edit", "exec", "read", "wait", "write"]);
    expect(first.tools).toContain("codemode");
    expect(first.tools.some(name => name.startsWith("mcp__lxe_desktop__"))).toBe(false);
    const cli = await turn("cli", "cli");
    expect(cli.prompt).not.toContain("## mcp_servers");
    expect(cli.tools).not.toContain("codemode");
    await host.dashboardCall({ operation: "mcp.servers.update", input: { name: "lxe_desktop", enabled: false } });
    const next = await turn("desktop", "desktop");
    expect(next.prompt).toBe(first.prompt.split("\n\n## mcp_servers")[0]!);
    expect(next.tools).not.toContain("codemode");
    expect(next.descriptions.get("read")).toBe(first.descriptions.get("read")!.split("\n\nCodemode: ")[0]!);
    await host.dashboardCall({ operation: "mcp.servers.update", input: { name: "orders", enabled: true } });
    const orders = await turn("cli", "cli");
    expect(orders.prompt).toContain("- mcp__orders (tool_search): 查询订单");
    expect(orders.prompt).not.toContain("mcp__lxe_desktop");
    expect(orders.tools).toContain("tool_search");
    expect(orders.prompt).not.toContain("Use codemode");
    expect(orders.descriptions.get("exec")).toBe(cli.descriptions.get("exec"));
    expect(orders.descriptions.get("exec")).not.toContain("Codemode: ");
    await host.dashboardCall({ operation: "mcp.servers.add", input: { name: "team-skills", transport: "streamable-http", url: protectedServer.url.href } });
    const current = async () => (await host.dashboardCall({ operation: "mcp.servers.list", input: {} })).items.find(x => x.name === "team-skills");
    const deadline = Date.now() + 3_000;
    while ((await current())?.status === "connecting" && Date.now() < deadline) await Bun.sleep(10);
    expect((await current())?.status).toBe("needs_auth");
    expect(host.mcpLoginTarget!("team-skills")).toMatchObject({ url: protectedServer.url.href, scope: "orders.read" });
    const waiting = await turn("desktop", "desktop");
    expect(waiting.prompt).toContain("- mcp__team-skills (codemode)");
    expect(waiting.prompt).not.toContain("401");
    expect(waiting.tools.some(name => name.startsWith("mcp__team-skills__"))).toBe(false);
    const listing = await host.dashboardCall({ operation: "mcp.servers.list", input: {} });
    expect(listing.items.find(x => x.name === "team-skills")).toMatchObject({ tool_count: 0, tools: [] });
    await expect(host.mcpLoginComplete!({ name: "team-skills", url: "https://different.test/", access_token: "oauth-fixture" })).rejects.toThrow("target changed");
    await host.mcpLoginComplete!({ name: "team-skills", url: protectedServer.url.href, access_token: "oauth-fixture" });
    expect(await current()).toMatchObject({ status: "ready", tool_count: 2 });
    expect(JSON.stringify(received)).not.toContain("oauth-fixture");
    expect(readFileSync(join(root, "config/mcp_servers.local.json"), "utf8")).not.toContain("oauth-fixture");
  } finally {
    await host.stop();
    protectedServer.stop(true);
    endpoint.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
});
