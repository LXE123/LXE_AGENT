/** Only public authorization instructions, never callback codes or OAuth tokens. */
export type McpLoginProgress = { type: "authorization_required"; url: string } | { type: "credentials_saved" };

export function printMcpLoginProgress(name: string, value: unknown): void {
  if (!value || typeof value !== "object") throw new Error("Invalid MCP login progress");
  const event = value as Partial<{ type: string; url: string }>;
  if (event.type === "authorization_required" && typeof event.url === "string") {
    const url = URL.parse(event.url);
    if (!url || !["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error("Invalid MCP authorization URL");
    process.stdout.write(`Sign in to MCP server "${name}" in your browser:\n${url.href}\n`);
  } else if (event.type === "credentials_saved") {
    process.stdout.write(`OAuth credentials for MCP server "${name}" were saved. Verifying the connection.\n`);
  } else throw new Error("Invalid MCP login progress");
}
