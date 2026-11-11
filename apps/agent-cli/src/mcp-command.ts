import { join } from "node:path";
import { configureLogging } from "@lxe/core";
import { addMcpServer, loadMcpConfig, removeMcpServer, ToolRegistry, usesMcpOAuth, type McpConfig } from "@lxe/runtime";
import { resolveExecRuntimePaths } from "./exec-paths";
import { McpAccess } from "./mcp-access";
import { McpAuthStore } from "./mcp-auth-store";
import { parseMcpCommand, requireMcpServer, usage } from "./mcp-command-args";
import { printMcpLoginProgress } from "./mcp-login-progress";
import { withMcpConfigLock } from "./mcp-config-lock";
import { sessionMcpConfig } from "./session-mcp";

function printList(config: McpConfig, access: McpAccess, source: string, json: boolean): number {
  const errors = config.errors ?? [];
  const servers = config.servers.map(server => {
    const status = access.manager.status(server.name);
    const state = status.state === "ready" ? "connected" : status.state === "needs_auth" ? "needs-auth"
      : status.state === "error" ? "failed" : status.state;
    return { name: server.name, scope: "global", source, enabled: server.enabled, exposure: server.exposure,
      transport: server.transport === "stdio" ? [server.command, ...server.args].join(" ") : server.url,
      state, tools: status.tools.map(tool => tool.rawName),
      ...(status.resources && { resources: true }),
      ...(status.error && !status.connected && { error: status.error }) };
  });
  if (json) process.stdout.write(JSON.stringify({ servers, errors }, null, 2) + "\n");
  else {
    if (!servers.length && !errors.length) process.stdout.write(`No MCP servers configured. Add them with agent-cli mcp add or edit ${source}.\n`);
    for (const server of servers) {
      const state = server.state === "connected" ? `connected, ${server.tools.length} ${server.tools.length === 1 ? "tool" : "tools"}`
        : server.state === "needs-auth" ? "needs sign-in" : server.state;
      process.stdout.write(`${server.name}: ${state} (${server.exposure}, ${server.scope})\n  ${server.transport}\n`);
      if (server.state === "needs-auth") process.stdout.write(`  sign in with: agent-cli mcp login ${server.name}\n`);
      if (server.tools.length) process.stdout.write(`  tools: ${server.tools.join(", ")}\n`);
      if (server.resources) process.stdout.write("  offers resources\n");
      if (server.error) process.stdout.write(`  ${server.error.split("\n").join("\n  ")}\n`);
    }
    for (const error of errors) process.stdout.write(`config error: ${error}\n`);
  }
  return errors.length || servers.some(server => server.enabled && server.state !== "connected") ? 1 : 0;
}

/** Terminal commands own temporary connections, including when invoked by a model. */
export async function runMcpCommand(args: string[], openBrowser?: (url: string) => Promise<void>): Promise<number> {
  let cmd: ReturnType<typeof parseMcpCommand>;
  try { cmd = parseMcpCommand(args); }
  catch (error) { process.stderr.write(`${(error as Error).message}\n${usage}`); return 1; }
  if (cmd.kind === "help") { process.stdout.write(usage); return 0; }
  const { dataRoot } = resolveExecRuntimePaths();
  const configPath = process.env.LXE_MCP_CONFIG_PATH?.trim() || join(dataRoot, "config", "mcp_servers.local.json");
  const logging = configureLogging({ projectRoot: dataRoot, stateRoot: dataRoot, fileName: "mcp-cli.log",
    environment: process.env, consoleEnabled: false });
  try { return await executeMcpCommand(cmd, dataRoot, configPath, openBrowser); }
  finally { await logging.close(); }
}

async function executeMcpCommand(cmd: Exclude<ReturnType<typeof parseMcpCommand>, { kind: "help" }>,
  dataRoot: string, configPath: string, openBrowser?: (url: string) => Promise<void>): Promise<number> {
  if (cmd.kind === "add" || cmd.kind === "remove") {
    await withMcpConfigLock(configPath, () => {
      if (cmd.kind === "add") addMcpServer(configPath, cmd.name, cmd.definition, process.env, "", true);
      else removeMcpServer(configPath, cmd.name);
    });
    process.stdout.write(`${cmd.kind === "add" ? "Saved" : "Removed"} MCP server "${cmd.name}" in ${configPath}.\n`);
    if (cmd.kind === "add") process.stdout.write("Check with: agent-cli mcp list\n");
    return 0;
  }
  const config = sessionMcpConfig(loadMcpConfig(configPath, process.env), process.cwd(), "cli");
  const store = new McpAuthStore(dataRoot);
  if (cmd.kind !== "list") {
    for (const error of config.errors ?? []) process.stderr.write(`config error: ${error}\n`);
    const server = requireMcpServer(cmd.name, config.servers);
    if (!usesMcpOAuth(server)) throw new Error(`MCP ${cmd.kind} requires a Streamable HTTP server without a configured Authorization header`);
    if (cmd.kind === "logout") {
      const removed = await store.forget(server.name, server.url);
      process.stdout.write(removed ? `Signed out of MCP server "${cmd.name}".\n` : `No stored credentials for MCP server "${cmd.name}".\n`);
      return 0;
    }
    // Explicit login can check a disabled server without changing its configuration.
    config.servers = [{ ...server, enabled: true }];
    process.stdout.write(`Checking connection to MCP server "${cmd.name}".\n`);
  }
  const access = new McpAccess(config, store, process.env, openBrowser);
  try {
    await access.manager.start(new ToolRegistry());
    if (cmd.kind === "list") return printList(config, access, configPath, cmd.json);
    const status = access.manager.status(cmd.name);
    if (status.connected) process.stdout.write(`Already signed in to MCP server "${cmd.name}" (${status.toolCount} tools).\n`);
    else {
      if (status.state !== "needs_auth") throw new Error(`MCP server "${cmd.name}" failed to connect:\n${status.error || status.state}`);
      await access.login(cmd.name, undefined, event => printMcpLoginProgress(cmd.name, event), cmd.timeout);
      process.stdout.write(`Signed in to MCP server "${cmd.name}" (${access.manager.status(cmd.name).toolCount} tools).\n`);
    }
  } finally {
    access.stop();
    await access.manager.stop();
  }
  return 0;
}
