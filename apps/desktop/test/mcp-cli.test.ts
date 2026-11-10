import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withExecutablePath } from "@lxe/core";
import { requestDesktopPipe } from "@lxe/desktop-protocol/local-pipe";
import { openMcpCliBridge } from "../src/main/mcp-cli-bridge";

test("desktop exec can list and sign in by the original server name using only the scoped CLI pipe", async () => {
  let state = "needs_auth";
  const calls: string[] = [];
  const bridge = await openMcpCliBridge({
    list: async () => [{ name: "team-skills", transport: "streamable-http", status: state, tool_count: state === "ready" ? 2 : 0, error: "",
      access_token: "must-not-be-returned" }],
    login: async name => {
      calls.push(name);
      if (name !== "team-skills") throw new Error("MCP server not found: " + name);
      state = "ready";
    },
  });
  const { LXE_MCP_CLI_PIPE: path, LXE_MCP_CLI_TOKEN: token } = bridge.environment;
  const env = withExecutablePath({ ...process.env, ...bridge.environment, LXE_MCP_CLI_BUN: process.execPath },
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
    expect(await requestDesktopPipe(path, token, "mcp/list", {})).toEqual([
      { name: "team-skills", status: "needs_auth", transport: "streamable-http", tool_count: 0, error: "" },
    ]);
    expect(await command("agent-cli mcp list")).toMatchObject({ code: 0, out: expect.stringContaining("Sign in with: agent-cli mcp login team-skills") });
    expect(await command("agent-cli mcp login team_skills")).toMatchObject({ code: 1, err: expect.stringContaining("MCP server not found: team_skills") });
    expect(await command("agent-cli mcp login team-skills")).toMatchObject({ code: 0, out: expect.stringContaining("Signed in and connected to team-skills") });
    expect(await command("agent-cli mcp list")).toMatchObject({ code: 0, out: "team-skills: ready (streamable-http, 2 tools)\n" });
    expect(await command("agent-cli mcp login team-skills")).toMatchObject({ code: 0, out: expect.stringContaining("already connected") });
    expect(calls).toEqual(["team_skills", "team-skills"]);
    await expect(requestDesktopPipe(path, token, "mcp.servers.add", {})).rejects.toThrow("Unknown MCP management command");
    expect(await command("agent-cli mcp login team-skills", { ...env, LXE_MCP_CLI_TOKEN: "" })).toMatchObject({ code: 1, err: expect.stringContaining("active desktop chat") });
  } finally { await bridge.close(); }
}, 30_000);

test("terminating a pending CLI request cancels its browser login", async () => {
  const started = Promise.withResolvers<void>(), cancelled = Promise.withResolvers<void>();
  const bridge = await openMcpCliBridge({ list: async () => [], login: async (_name, signal) => {
    started.resolve();
    await new Promise<void>(resolve => signal.addEventListener("abort", resolve.bind(null, undefined), { once: true }));
    cancelled.resolve();
    throw new Error("cancelled");
  } });
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../../agent-cli/src/main.ts"), "mcp", "login", "docs"], {
    env: { ...process.env, ...bridge.environment }, stdout: "ignore", stderr: "ignore",
  });
  try {
    await started.promise;
    child.kill();
    await Promise.all([child.exited, cancelled.promise]);
  } finally { child.kill(); await bridge.close(); }
});
