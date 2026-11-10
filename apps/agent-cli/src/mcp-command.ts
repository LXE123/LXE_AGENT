import { MCP_CLI_LOGIN_TIMEOUT_MS, type McpCliServer } from "@lxe/desktop-protocol";
import { requestDesktopPipe } from "@lxe/desktop-protocol/local-pipe";

import { join } from "node:path";
import { loadMcpConfig, ToolRegistry } from "@lxe/runtime";
import { resolveExecRuntimePaths } from "./exec-paths";
import { McpAuthStore } from "./mcp-auth-store";
import { McpAccess } from "./mcp-access";

const usage = "Usage: agent-cli mcp list | agent-cli mcp login <server>\n";
export async function runMcpCommand(args: string[], openBrowser?: (url: string) => Promise<void>): Promise<number> {
  if (args.length === 1 && ["-h", "--help"].includes(args[0]!)) {
    process.stdout.write(usage);
    return 0;
  }
  const list = args.length === 1 && args[0] === "list";
  const name = args[1];
  if (!list && !(args.length === 2 && args[0] === "login" && name && /^[A-Za-z0-9_-]+$/.test(name))) {
    process.stderr.write(usage);
    return 2;
  }
  const path = process.env.LXE_MCP_CLI_PIPE;
  const token = process.env.LXE_MCP_CLI_TOKEN;
  if (!!path !== !!token) throw new Error("Incomplete MCP management connection");
  if (!path || !token) {
    const { dataRoot } = resolveExecRuntimePaths();
    const configPath = process.env.LXE_MCP_CONFIG_PATH?.trim() || join(dataRoot, "config", "mcp_servers.local.json");
    const config = loadMcpConfig(configPath, process.env, dataRoot);
    const store = new McpAuthStore(dataRoot);
    if (list) {
      if (!config.servers.length) process.stdout.write("No MCP servers configured.\n");
      for (const server of config.servers) {
        const saved = server.transport === "streamable-http" && store.get(server.name, server.url);
        process.stdout.write(`${server.name}: ${server.enabled ? "configured" : "disabled"} (${server.transport}${saved ? ", saved OAuth credentials" : ""})\n`);
      }
      return 0;
    }
    const server = config.servers.find(s => s.name === name);
    if (!server) throw new Error("MCP server not found: " + name);
    if (!server.enabled || server.transport !== "streamable-http") throw new Error("MCP login requires an enabled Streamable HTTP server");
    const access = new McpAccess({ servers: [server] }, store, process.env, openBrowser);
    try {
      await access.manager.start(new ToolRegistry());
      const status = access.manager.status(server.name);
      if (status.connected) process.stdout.write(`${server.name} is already connected.\n`);
      else {
        if (status.state !== "needs_auth") throw new Error(status.error || status.state);
        process.stdout.write(`Requesting sign-in for ${name}. If prompted, approve access in your browser.\n`);
        await access.login(server.name);
        process.stdout.write(`Signed in and connected to ${name}.\n`);
      }
    } finally { access.stop(); await access.manager.stop(); }
    return 0;
  }
  if (list) {
    const servers = await requestDesktopPipe(path, token, "mcp/list", {}) as McpCliServer[];
    if (!servers.length) process.stdout.write("No MCP servers configured.\n");
    for (const server of servers) {
      process.stdout.write(`${server.name}: ${server.status} (${server.transport}, ${server.tool_count} tools)\n`);
      if (server.error) process.stdout.write(`  ${server.error}\n`);
      if (server.status === "needs_auth") process.stdout.write(`  Sign in with: agent-cli mcp login ${server.name}\n`);
    }
  } else {
    process.stdout.write(`Requesting sign-in for ${name}. If prompted, approve access in your browser.\n`);
    const result = await requestDesktopPipe(path, token, "mcp/login", { name }, undefined, MCP_CLI_LOGIN_TIMEOUT_MS);
    process.stdout.write(result === "already_connected" ? `${name} is already connected.\n` : `Signed in and connected to ${name}.\n`);
  }
  return 0;
}
