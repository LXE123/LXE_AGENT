// Use the same JavaScript identifier for a model declaration and a codemode call.
// Configuration keys and MCP tools/call names are kept separately in their original form.
const modelIdentifier = (value: string): string => value.replace(/[^A-Za-z0-9_]/gu, "_");
export const mcpNamespace = (server: string): string => `mcp__${modelIdentifier(server)}`;
export const mcpServerPrefix = (server: string): string => `${mcpNamespace(server)}__`;

export function reserveMcpNamespace(owners: Map<string, string>, server: string): void {
  const namespace = mcpNamespace(server);
  const other = owners.get(namespace);
  if (other !== undefined) throw new Error(`MCP servers "${server}" and "${other}" share the model namespace "${namespace}"`);
  owners.set(namespace, server);
}

export function mcpToolName(server: string, tool: string): string {
  const name = mcpServerPrefix(server) + modelIdentifier(tool);
  return name.length <= 64 ? name : withSuffix(name, server, tool);
}

function withSuffix(candidate: string, server: string, tool: string, attempt = 0): string {
  const seed = `${server}\0${tool}${attempt ? `\0${attempt}` : ""}`;
  const hash = new Bun.CryptoHasher("sha1").update(seed).digest("hex").slice(0, 10);
  return `${candidate.slice(0, 64 - hash.length - 1).replace(/_+$/u, "")}_${hash}`;
}

export function uniqueMcpToolName(server: string, tool: string, used: ReadonlySet<string>): string {
  const candidate = mcpToolName(server, tool);
  if (!used.has(candidate)) return candidate;
  for (let attempt = 0; ; attempt++) {
    const name = withSuffix(candidate, server, tool, attempt);
    if (!used.has(name)) return name;
  }
}
