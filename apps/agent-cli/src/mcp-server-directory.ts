import type { McpConfig, McpManager, McpServerConfig } from "@lxe/runtime";

export function mcpServerEnabledOnPlatform(server: McpServerConfig, platform: string | undefined): boolean {
  return server.enabled && (!server.platforms || server.platforms.includes(platform ?? ""));
}

const DIRECTORY_LIMIT = 4096;
const SUMMARY_LIMIT = 250;

function omissionLine(count: number): string {
  return count ? `\n… ${count} more MCP ${count === 1 ? "server" : "servers"}` : "";
}

export function renderMcpServerDirectory(config: McpConfig, platform: string, manager: Pick<McpManager, "serverInstructions">): string {
  const servers = config.servers
    .filter(server => mcpServerEnabledOnPlatform(server, platform) && (server.exposure === "codemode" || server.exposure === "deferred"))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!servers.length) return "";

  const intro = [
    "## mcp_servers",
    ...(servers.some(server => server.exposure === "codemode") ? [
      "Use codemode to batch independent tool calls with Promise.allSettled, chain dependent calls in order, or filter large results before returning them.",
    ] : []),
    "Use the indicated discovery tool to find tools in each namespace.",
  ].join("\n");
  const names: string[] = [];
  let remaining = DIRECTORY_LIMIT - intro.length;
  let omitted = "";
  // Reserve room for namespace names before sharing the remaining space among summaries.
  for (const server of servers) {
    const line = `- mcp__${server.name} (${server.exposure === "codemode" ? "codemode" : "tool_search"})`;
    const count = servers.length - names.length;
    if (line.length + 1 + omissionLine(count - 1).length > remaining) {
      omitted = omissionLine(count);
      remaining -= omitted.length;
      break;
    }
    names.push(line);
    remaining -= line.length + 1;
  }
  const limit = Math.min(SUMMARY_LIMIT, Math.floor(remaining / Math.max(1, names.length)) - 2);
  const lines = names.map((line, index) => {
    const server = servers[index]!;
    if (limit < 2) return line;
    const text = server.connectorDescription.trim() || manager.serverInstructions(server.name)?.trim() || "";
    const firstLine = text.split(/[\r\n\u2028\u2029]/u, 1)[0]!.trim();
    const summary = firstLine.length > limit ? firstLine.slice(0, limit - 1).replace(/[\uD800-\uDBFF]$/u, "").trimEnd() + "…" : firstLine;
    return summary ? `${line}: ${summary}` : line;
  });
  return [intro, ...lines].join("\n") + omitted;
}
