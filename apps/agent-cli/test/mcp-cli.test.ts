import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { McpAuthStore } from "../src/mcp-auth-store";
import { ExecSandbox } from "../../../packages/agent/runtime/src/permissions/exec-sandbox";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
      { cwd: root, env: { ...process.env, LXE_DATA_ROOT: root, LXE_MCP_CONFIG_PATH: path, LXE_MCP_CLI_PIPE: "", LXE_MCP_CLI_TOKEN: "",
        LXE_WORKSPACE_ROOT: "", LOCAL_LOGS_ENABLED: "1", LOG_LEVEL: "DEBUG", RUNTIME_LOG_LEVEL: "DEBUG" },
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
    expect(JSON.parse(partial.out).servers).toContainEqual(expect.objectContaining({ name: "broken", state: "failed", error: expect.stringMatching(/.+/) }));
    expect((await cli("remove", "broken")).code).toBe(0);
    expect((await cli("remove", "lxe-desktop")).code).not.toBe(0);
    expect((await cli("add", "docs", "--url", url, "--local")).code).toBe(1);
    expect((await cli("add", "docs", "--url", url, "--description", "replacement")).code).toBe(0);
    expect(doc().mcpServers.docs).not.toHaveProperty("headers");
    await auth.save({ name: "docs", url, access_token: "fixture-only" });
    await auth.save({ name: "other", url, access_token: "other-fixture-only" });
    expect((await cli("remove", "docs")).code).toBe(0);
    expect(auth.get("docs", url)).toBeDefined();
    const listing = await cli("list", "--json");
    expect(listing.code, listing.err).toBe(0);
    expect(listing.err).toBe("");
    expect(listing.out).not.toContain("mcp_connection_stage");
    const logFiles = [...new Bun.Glob(".lxeagent/logs/runtime/*/mcp-cli.log").scanSync({ cwd: root, absolute: true })];
    expect(logFiles.length).toBeGreaterThan(0);
    expect(logFiles.map(file => readFileSync(file, "utf8")).join("\n")).toContain("mcp_connection_stage_completed");
    expect(existsSync(join(root, "logs"))).toBe(false);
    const { servers: [files, off], errors } = JSON.parse(listing.out);
    expect(errors).toEqual([]);
    expect(files).toMatchObject({ name: "files", state: "connected", scope: "global", source: path });
    expect(files.tools).toEqual(["echo", "second"]);
    expect(off).toMatchObject({ name: "off", state: "disabled", tools: [] });
    const lifecycle = readFileSync(trace, "utf8").trim().split("\n").map(line => JSON.parse(line));
    const spawned = lifecycle.filter(entry => entry.event === "spawn").map(entry => entry.pid);
    expect(spawned.length).toBeGreaterThan(0);
    // SDK probe subprocesses can exit by signal without running an exit handler.
    for (const pid of spawned) {
      let error: NodeJS.ErrnoException | undefined;
      try { process.kill(pid, 0); } catch (cause) { error = cause as NodeJS.ErrnoException; }
      expect(error?.code).toBe("ESRCH");
    }
    expect((await cli("add", "docs", "--url", url)).code).toBe(0);
    expect((await cli("logout", "docs")).code).toBe(0);
    expect(auth.get("docs", url)).toBeUndefined();
    expect(auth.get("other", url)).toBeDefined();
    expect(doc().mcpServers.docs.url).toBe(url);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30_000);

test.each(process.platform === "darwin" ? [false, true] : [false])(
  "MCP diagnostics stay in the selected workspace after cd (sandbox=%s)", async confined => {
    // Keep the data root outside both the selected workspace and OS temp grants.
    const root = realpathSync(mkdtempSync(join(process.cwd(), ".lxe-mcp-log-")));
    const workspace = join(root, "workspace 中文"), cwd = join(workspace, "nested"), dataRoot = join(root, "data");
    const configPath = join(dataRoot, "config", "mcp_servers.local.json");
    const sandbox = new ExecSandbox();
    const policy = { mode: "workspace-write" as const, workspaceRoot: workspace, sessionId: root };
    mkdirSync(cwd, { recursive: true });
    mkdirSync(join(dataRoot, "config"), { recursive: true });
    writeFileSync(configPath, JSON.stringify({ mcpServers: { files: { enabled: true, command: process.execPath,
      args: [join(import.meta.dir, "../../../packages/agent/runtime/test/tooling/protocol-mcp-server.fixture.ts"), "modern"],
    } } }));
    const run = async (argv: string[]) => {
      const spec = confined ? await sandbox.prepare(policy, { argv, detached: false }) : { argv };
      const child = Bun.spawn(spec.argv, { cwd, env: { ...process.env, LXE_WORKSPACE_ROOT: workspace,
        LXE_DATA_ROOT: dataRoot, LXE_MCP_CONFIG_PATH: configPath,
        LOCAL_LOGS_ENABLED: "1", RUNTIME_LOG_LEVEL: "DEBUG" }, stdout: "pipe", stderr: "pipe" });
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      return { out, err, code };
    };
    try {
      if (confined) {
        const denied = await run([process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(join(dataRoot, "denied"))}, 'no')`]);
        expect(denied.code).not.toBe(0);
        expect(denied.err).toMatch(/EPERM|EACCES|Operation not permitted/i);
        expect(existsSync(join(dataRoot, "denied"))).toBe(false);
      }
      const result = await run([process.execPath, join(import.meta.dir, "../src/main.ts"), "mcp", "list", "--json"]);
      expect(result.code, result.err).toBe(0);
      expect(result.err).toBe("");
      expect(JSON.parse(result.out).servers).toContainEqual(expect.objectContaining({ name: "files", state: "connected", source: configPath, tools: ["echo", "second"] }));
      const logFiles = [...new Bun.Glob(".lxeagent/logs/runtime/*/mcp-cli.log").scanSync({ cwd: workspace, absolute: true })];
      expect(logFiles.length).toBeGreaterThan(0);
      expect(logFiles.map(file => readFileSync(file, "utf8")).join("\n")).toContain("mcp_connection_stage_completed");
      expect(existsSync(join(cwd, ".lxeagent"))).toBe(false);
      expect(existsSync(join(dataRoot, "logs"))).toBe(false);
    } finally {
      await sandbox.stop();
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 30_000,
);
