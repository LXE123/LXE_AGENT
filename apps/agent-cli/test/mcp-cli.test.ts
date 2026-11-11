import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { McpAuthStore } from "../src/mcp-auth-store";
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
