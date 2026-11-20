import type { NormalizedToolDefinition } from "./registry";

/** MCP model names can change when sanitized names collide after a reconnect. */
export type ToolReference = { name: string; server?: string };

export function referenceForTool(tool: NormalizedToolDefinition): ToolReference {
  return tool.source === "mcp" && tool.connectorName
    ? { server: tool.connectorName, name: tool.rawName ?? tool.name }
    : { name: tool.name };
}

export function toolReferenceKey(ref: ToolReference): string {
  return JSON.stringify([ref.server ?? null, ref.name]);
}
