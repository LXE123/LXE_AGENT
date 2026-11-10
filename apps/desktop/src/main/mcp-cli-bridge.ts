import { randomBytes } from "node:crypto";
import { MCP_CLI_LOGIN_TIMEOUT_MS, type McpCliServer } from "@lxe/desktop-protocol";
import { startDesktopPipe } from "../mcp/pipe";

/** Grant desktop chat commands only status and interactive sign-in, never the dashboard or credential store. */
export async function openMcpCliBridge(options: {
  list(): Promise<McpCliServer[]>;
  login(name: string, signal: AbortSignal): Promise<void>;
}) {
  const token = randomBytes(32).toString("hex");
  const pipe = await startDesktopPipe({ token, timeoutMs: MCP_CLI_LOGIN_TIMEOUT_MS, async call(method, params, signal) {
    if (method === "mcp/list") {
      return (await options.list()).map(({ name, status, transport, tool_count, error }) => ({ name, status, transport, tool_count, error }));
    }
    if (method === "mcp/login") {
      const name = (params as { name?: unknown } | null)?.name;
      if (typeof name !== "string" || !/^[A-Za-z0-9_-]+$/.test(name)) throw new Error("Invalid MCP server name");
      if ((await options.list()).some(server => server.name === name && server.status === "ready")) return "already_connected";
      await options.login(name, signal);
      return "connected";
    }
    throw new Error("Unknown MCP management command");
  } });
  return { environment: { LXE_MCP_CLI_PIPE: pipe.path, LXE_MCP_CLI_TOKEN: token }, close: pipe.close };
}
