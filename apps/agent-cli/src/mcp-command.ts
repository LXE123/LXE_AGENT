import { join } from "node:path";
import { MCP_CLI_LOGIN_TIMEOUT_MS, type McpCliServer } from "@lxe/desktop-protocol";
import { requestDesktopPipe } from "@lxe/desktop-protocol/local-pipe";
import { addMcpServer, loadMcpConfig, removeMcpServer, ToolRegistry, usesMcpOAuth } from "@lxe/runtime";
import { resolveExecRuntimePaths } from "./exec-paths";
import { McpAccess } from "./mcp-access";
import { McpAuthStore } from "./mcp-auth-store";
import { parseMcpCommand, usage } from "./mcp-command-args";
import { withMcpConfigLock } from "./mcp-config-lock";

function printList(servers: McpCliServer[], json: boolean): number {
  if (json) process.stdout.write(JSON.stringify(servers, null, 2) + "\n");
  else {
    if (!servers.length) process.stdout.write("No MCP servers configured.\n");
    for (const server of servers) {
      process.stdout.write(`${server.name}: ${server.status} (${server.transport}, ${server.tool_count} ${server.tool_count === 1 ? "tool" : "tools"})\n`);
      for (const tool of server.tools) process.stdout.write(`  ${tool.rawName}\n`);
      if (server.error) process.stdout.write(`  ${server.error}\n`);
      if (server.status === "needs_auth") process.stdout.write(`  Sign in with: agent-cli mcp login ${server.name}\n`);
    }
  }
  return servers.some(s => s.status !== "ready" && s.status !== "disabled") ? 1 : 0;
}

export async function runMcpCommand(args: string[], openBrowser?: (url: string) => Promise<void>): Promise<number> {
  if (args.length === 1 && ["-h", "--help"].includes(args[0]!)) { process.stdout.write(usage); return 0; }
  let cmd: ReturnType<typeof parseMcpCommand>;
  try { cmd = parseMcpCommand(args); }
  catch (error) { process.stderr.write(`${(error as Error).message}\n${usage}`); return 2; }
  const path = process.env.LXE_MCP_CLI_PIPE, token = process.env.LXE_MCP_CLI_TOKEN;
  if (!!path !== !!token) throw new Error("Incomplete MCP management connection");
  const { dataRoot } = resolveExecRuntimePaths();
  const configPath = process.env.LXE_MCP_CONFIG_PATH?.trim() || join(dataRoot, "config", "mcp_servers.local.json");

  // Edit as the invoking process, with its normal filesystem permissions. The chat
  // pipe must never be a route to execute a new stdio command in the host.
  if (cmd.kind === "add" || cmd.kind === "remove") {
    await withMcpConfigLock(configPath, () => {
      if (cmd.kind === "add") addMcpServer(configPath, cmd.name, cmd.definition, process.env, dataRoot, true);
      else removeMcpServer(configPath, cmd.name);
    });
    process.stdout.write(`${cmd.kind === "add" ? "Saved" : "Removed"} ${cmd.name} in user configuration. Restart any running Harness to load this file change.\n`);
    return 0;
  }
  const signal = cmd.kind === "login" ? AbortSignal.timeout(cmd.timeout) : undefined;
  if (cmd.kind === "login") process.stdout.write(`Requesting sign-in for ${cmd.name}. If prompted, approve access in your browser.\n`);
  const reportLogout = (name: string, removed: boolean) => process.stdout.write(removed ? `Forgot saved OAuth credentials for ${name}.\n` : "No saved OAuth credentials.\n");
  if (path && token) {
    if (cmd.kind === "list") return printList(await requestDesktopPipe(path, token, "mcp/list", {}) as McpCliServer[], cmd.json);
    if (cmd.kind === "logout") reportLogout(cmd.name, await requestDesktopPipe(path, token, "mcp/logout", { name: cmd.name }) === true);
    else {
      const result = await requestDesktopPipe(path, token, "mcp/login", { name: cmd.name }, signal, MCP_CLI_LOGIN_TIMEOUT_MS);
      process.stdout.write(result === "already_connected" ? `${cmd.name} is already connected.\n` : `Signed in and connected to ${cmd.name}.\n`);
    }
    return 0;
  }
  const config = loadMcpConfig(configPath, process.env, dataRoot);
  const store = new McpAuthStore(dataRoot);
  if (cmd.kind !== "list") {
    const server = config.servers.find(s => s.name === cmd.name);
    if (!server) throw new Error("MCP server not found: " + cmd.name);
    if (server.transport !== "streamable-http") throw new Error("MCP OAuth requires a Streamable HTTP server");
    if (cmd.kind === "logout") {
      if (!usesMcpOAuth(server)) throw new Error("MCP logout requires a Streamable HTTP server without a configured Authorization header");
      reportLogout(cmd.name, await store.forget(server.name, server.url));
      return 0;
    }
    if (!server.enabled) throw new Error("MCP login requires an enabled server");
    config.servers = [server];
  }
  const access = new McpAccess(config, store, process.env, openBrowser);
  const abort = () => { access.stop(); void access.manager.stop(); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    await access.manager.start(new ToolRegistry());
    if (cmd.kind === "list") return printList(config.servers.map(({ name, transport }) => {
      const { state: status, toolCount: tool_count, error, tools } = access.manager.status(name);
      return { name, status, transport, tool_count, error, tools };
    }), cmd.json);
    signal?.throwIfAborted();
    const status = access.manager.status(cmd.name);
    if (status.connected) process.stdout.write(`${cmd.name} is already connected.\n`);
    else {
      if (status.state !== "needs_auth" && !access.canRelogin(cmd.name)) throw new Error(status.error || status.state);
      await access.login(cmd.name, signal);
      process.stdout.write(`Signed in and connected to ${cmd.name}.\n`);
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    access.stop();
    await access.manager.stop();
  }
  return 0;
}
