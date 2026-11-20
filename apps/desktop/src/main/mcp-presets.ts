import { readFileSync } from "node:fs";
import { parseMcpServerPresets, type McpServerPreset } from "@lxe/desktop-protocol";

/** Read the product resource, not the Harness-owned user configuration. */
export function loadDesktopMcpPresets(path: string): McpServerPreset[] {
  const root = JSON.parse(readFileSync(path, "utf8"));
  if (!root || typeof root !== "object" || Array.isArray(root)
    || !root.servers || typeof root.servers !== "object" || Array.isArray(root.servers)
    || Object.keys(root).some(key => key !== "servers")) {
    throw new Error(`Invalid desktop MCP preset document: ${path}`);
  }
  return parseMcpServerPresets(Object.entries(root.servers).map(([name, value]) => {
    if (!value || typeof value !== "object" || Array.isArray(value) || "name" in value) {
      throw new Error(`Invalid desktop MCP preset ${name}: ${path}`);
    }
    return { ...value, name };
  }));
}
