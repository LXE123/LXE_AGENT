import { MCP_CLI_LOGIN_TIMEOUT_MS, type McpCliServer } from "@lxe/desktop-protocol";
import { requestDesktopPipe } from "@lxe/desktop-protocol/local-pipe";

const usage = "Usage: agent-cli mcp list | agent-cli mcp login <server>\n";
export async function runMcpCommand(args: string[]): Promise<number> {
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
  if (!path || !token) throw new Error("MCP management requires an active desktop chat. Run this command through its exec tool.");
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
