import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { McpAuthStore } from "../src/mcp-auth-store";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withExecutablePath } from "@lxe/core";
import { requestDesktopPipe } from "@lxe/desktop-protocol/local-pipe";
import { openMcpCliBridge } from "../src/mcp-cli-bridge";

test("desktop exec can list and sign in by the original server name using only the scoped CLI pipe", async () => {
  let state = "needs_auth";
  const calls: string[] = [];
  const tools = [{ rawName: "find", modelName: "mcp__team_skills__find" }];
  const bridge = await openMcpCliBridge({
    list: async sessionId => { expect(sessionId).toBe("chat-A"); return [{ name: "team-skills", transport: "streamable-http", status: state, tool_count: state === "ready" ? 1 : 0, error: "", tools: state === "ready" ? tools : [],
      access_token: "must-not-be-returned" }]; },
    logout: async () => { state = "needs_auth"; return true; },
    login: async name => {
      calls.push(name);
      if (name !== "team-skills") throw new Error("MCP server not found: " + name);
      state = "ready";
    },
  });
  const { LXE_MCP_CLI_PIPE: path, LXE_MCP_CLI_TOKEN: token } = bridge.environment;
  const env = withExecutablePath({ ...process.env, ...bridge.environment, LXE_MCP_CLI_SESSION_ID: "chat-A", LXE_MCP_CLI_BUN: process.execPath },
    join(import.meta.dir, "../../agent-cli/bin"));
  async function command(line: string, envOverride = env) {
    const argv = process.platform === "win32"
      ? ["powershell.exe", "-NoProfile", "-Command", line + "; exit $LASTEXITCODE"]
      : ["/bin/sh", "-c", line];
    const child = Bun.spawn(argv, { cwd: tmpdir(), env: envOverride, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { out, err, code };
  }
  try {
    expect(await requestDesktopPipe(path, token, "mcp/list", { session_id: "chat-A" })).toEqual([
      { name: "team-skills", status: "needs_auth", transport: "streamable-http", tool_count: 0, error: "", tools: [] },
    ]);
    expect(await command("agent-cli mcp list")).toMatchObject({ code: 1, out: expect.stringContaining("Sign in with: agent-cli mcp login team-skills") });
    expect(await command("agent-cli mcp login team_skills")).toMatchObject({ code: 1, err: expect.stringContaining("MCP server not found: team_skills") });
    expect(await command("agent-cli mcp login team-skills")).toMatchObject({ code: 0, out: expect.stringContaining('Connected to MCP server "team-skills"') });
    expect(await command("agent-cli mcp list")).toMatchObject({ code: 0, out: "team-skills: ready (streamable-http, 1 tool)\n  find\n" });
    expect(await command("agent-cli mcp login team-skills")).toMatchObject({ code: 0, out: expect.stringContaining("already connected") });
    expect(JSON.parse((await command("agent-cli mcp list --json")).out)[0].tools).toEqual(tools);
    expect(await command("agent-cli mcp logout team-skills")).toMatchObject({ code: 0, out: expect.stringContaining("Forgot saved OAuth credentials") });
    expect(calls).toEqual(["team-skills"]);
    await expect(requestDesktopPipe(path, token, "mcp.servers.add", { session_id: "chat-A" })).rejects.toThrow("Unknown MCP management command");
    expect(await command("agent-cli mcp login team-skills", { ...env, LXE_MCP_CLI_TOKEN: "" })).toMatchObject({ code: 1, err: expect.stringContaining("Incomplete MCP management connection") });
  } finally { await bridge.close(); }
}, 30_000);

test("terminating a pending CLI request cancels its browser login", async () => {
  const started = Promise.withResolvers<void>(), cancelled = Promise.withResolvers<void>();
  const bridge = await openMcpCliBridge({ list: async () => [{ name: "docs", status: "needs_auth", transport: "streamable-http", tool_count: 0, tools: [], error: "" }], logout: async () => false, login: async (_name, signal, _sessionId, onProgress) => {
    onProgress({ type: "authorization_required", url: "https://example.invalid/authorize" });
    started.resolve();
    await new Promise<void>(resolve => signal.addEventListener("abort", resolve.bind(null, undefined), { once: true }));
    cancelled.resolve();
    throw new Error("cancelled");
  } });
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../../agent-cli/src/main.ts"), "mcp", "login", "docs"], {
    env: { ...process.env, ...bridge.environment, LXE_MCP_CLI_SESSION_ID: "chat-A" }, stdout: "ignore", stderr: "ignore",
  });
  try {
    await started.promise;
    child.kill();
    await Promise.all([child.exited, cancelled.promise]);
  } finally { child.kill(); await bridge.close(); }
});

test("standalone user commands preserve unrelated config, probe active tools and forget only the selected grant", async () => {
  const root = mkdtempSync(join(tmpdir(), "mcp-cli-user-"));
  const path = join(root, "config", "mcp_servers.local.json");
  const trace = join(root, "stdio.trace");
  const fixture = join(import.meta.dir, "../../../packages/agent/runtime/test/tooling/protocol-mcp-server.fixture.ts");
  mkdirSync(join(root, "config"));
  writeFileSync(path, JSON.stringify({ marker: 1, mcpServers: { off: { command: "not-installed", enabled: false } } }));
  const doc = () => JSON.parse(readFileSync(path, "utf8"));
  const auth = new McpAuthStore(root), url = "https://example.invalid/mcp";
  async function cli(...args: string[]) {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/main.ts"), "mcp", ...args],
      { cwd: root, env: { ...process.env, LXE_DATA_ROOT: root, LXE_MCP_CONFIG_PATH: path, LXE_MCP_CLI_PIPE: "", LXE_MCP_CLI_TOKEN: "" },
        stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { out, err, code };
  }
  try {
    const adds = await Promise.all([
      cli("add", "files", "--cwd", root, "--env", "MARK=A=B", "--", process.execPath, fixture, "modern", trace),
      cli("add", "docs", "--url", url, "--header", "X-Test=1", "--exposure", "deferred"),
    ]);
    for (const added of adds) expect(added.code, added.err).toBe(0);
    expect(existsSync(trace)).toBe(false); // Adding a command does not execute it.
    expect(doc()).toMatchObject({ marker: 1, mcpServers: {
      off: { enabled: false }, files: { env: { MARK: "A=B" }, cwd: root }, docs: { headers: { "X-Test": "1" }, exposure: "deferred" },
    } });
    const failed = await cli("add", "broken", "--", join(root, "nonexistent-command"));
    expect(failed.code, failed.err).toBe(0);
    // Probe only the local fixture and the failing executable.
    expect((await cli("remove", "docs")).code).toBe(0);
    const partial = await cli("list", "--json");
    expect(partial.code).toBe(1);
    expect(JSON.parse(partial.out)).toContainEqual(expect.objectContaining({ name: "broken", status: "error", error: expect.stringMatching(/.+/) }));
    expect((await cli("remove", "broken")).code).toBe(0);
    expect((await cli("remove", "lxe-desktop")).code).not.toBe(0);
    expect((await cli("add", "docs", "--url", url, "--local")).code).toBe(2);
    expect((await cli("add", "docs", "--url", url, "--description", "replacement")).code).toBe(0);
    expect(doc().mcpServers.docs).not.toHaveProperty("headers");
    await auth.save({ name: "docs", url, access_token: "fixture-only" });
    await auth.save({ name: "other", url, access_token: "other-fixture-only" });
    expect((await cli("remove", "docs")).code).toBe(0);
    expect(auth.get("docs", url)).toBeDefined();
    const listing = await cli("list", "--json");
    expect(listing.code, listing.err).toBe(0);
    const [files, off] = JSON.parse(listing.out);
    expect(files).toMatchObject({ name: "files", status: "ready", tool_count: 2 });
    expect(files.tools.map((t: { rawName: string }) => t.rawName)).toEqual(["echo", "second"]);
    expect(off).toMatchObject({ name: "off", status: "disabled", tools: [] });
    expect(readFileSync(trace, "utf8")).toContain('"event":"exit"');
    expect((await cli("add", "docs", "--url", url)).code).toBe(0);
    expect((await cli("logout", "docs")).code).toBe(0);
    expect(auth.get("docs", url)).toBeUndefined();
    expect(auth.get("other", url)).toBeDefined();
    expect(doc().mcpServers.docs.url).toBe(url);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30_000);
