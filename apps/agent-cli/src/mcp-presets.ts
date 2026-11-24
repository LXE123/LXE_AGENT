import { isDeepStrictEqual } from "node:util";
import { parseMcpServerPresets, type McpServerPreset } from "@lxe/desktop-protocol";
import { mcpNamespace, readMcpConfigDocument, writeMcpConfigDocument } from "@lxe/runtime";
import { withMcpConfigLock } from "./mcp-config-lock";

/** Reconcile host-owned fields without connecting or changing existing user preferences. */
export async function syncMcpServerPresets(path: string, input: readonly McpServerPreset[]): Promise<{ added: string[]; updated: string[] }> {
  const presets = parseMcpServerPresets(input);
  if (!presets.length) return { added: [], updated: [] };
  return withMcpConfigLock(path, () => {
    let root: Record<string, unknown>;
    try { root = readMcpConfigDocument(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      root = {};
    }
    const key = root.mcpServers !== undefined ? "mcpServers" : "servers";
    const servers = { ...(root[key] as Record<string, unknown> | undefined) };
    const added: string[] = [], updated: string[] = [];
    for (const { name, enabled, ...definition } of presets) {
      const collision = Object.keys(servers).find(other => other !== name && mcpNamespace(other) === mcpNamespace(name));
      if (collision) throw new Error(`MCP servers "${name}" and "${collision}" share the model namespace "${mcpNamespace(name)}"`);
      if (!Object.hasOwn(servers, name)) {
        servers[name] = { ...definition, enabled };
        added.push(name);
        continue;
      }
      const existing = servers[name];
      if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
        throw new Error(`MCP server ${name} must be an object`);
      }
      const current = existing as Record<string, unknown>;
      if (current.enabled !== undefined && typeof current.enabled !== "boolean") {
        throw new Error(`MCP ${name}.enabled must be a boolean`);
      }
      const next = { ...current, ...definition };
      if (!isDeepStrictEqual(current, next)) {
        servers[name] = next;
        updated.push(name);
      }
    }
    if (added.length || updated.length) writeMcpConfigDocument(path, { ...root, [key]: servers });
    return { added, updated };
  });
}
