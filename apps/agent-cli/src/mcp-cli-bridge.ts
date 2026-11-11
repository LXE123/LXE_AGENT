import { randomBytes } from "node:crypto";
import { MCP_CLI_LOGIN_TIMEOUT_MS, type McpCliServer } from "@lxe/desktop-protocol";
import { startDesktopPipe } from "@lxe/desktop-protocol/local-pipe-server";
import type { McpLoginProgress } from "./mcp-login-progress";
import { requireMcpServer } from "./mcp-command-args";

/** Grant local chat commands only status and OAuth actions, never the dashboard or credential store. */
export async function openMcpCliBridge(options: {
  list(sessionId: string): Promise<McpCliServer[]>;
  logout(name: string, sessionId: string): Promise<boolean>;
  login(name: string, signal: AbortSignal, sessionId: string, onProgress: (event: McpLoginProgress) => void): Promise<void>;
}) {
  const token = randomBytes(32).toString("hex");
  const pipe = await startDesktopPipe({ token, timeoutMs: MCP_CLI_LOGIN_TIMEOUT_MS, async call(method, params, signal, progress) {
    const sessionId = (params as { session_id?: unknown } | null)?.session_id;
    if (typeof sessionId !== "string" || !sessionId.trim()) throw new Error("MCP command requires its chat session");
    if (method === "mcp/list") {
      return (await options.list(sessionId)).map(({ name, status, transport, tool_count, error, tools }) => ({ name, status, transport, tool_count, error, tools: tools.map(({ rawName, modelName }) => ({ rawName, modelName })) }));
    }
    if (method === "mcp/login" || method === "mcp/logout") {
      const name = (params as { name?: unknown } | null)?.name;
      if (typeof name !== "string" || !/^[A-Za-z0-9_-]+$/.test(name)) throw new Error("Invalid MCP server name");
      const server = requireMcpServer(name, await options.list(sessionId));
      if (method === "mcp/logout") return options.logout(name, sessionId);
      if (server.status === "ready") return "already_connected";
      await options.login(name, signal, sessionId, progress);
      return "connected";
    }
    throw new Error("Unknown MCP management command");
  } });
  return { environment: { LXE_MCP_CLI_PIPE: pipe.path, LXE_MCP_CLI_TOKEN: token }, close: pipe.close };
}
