import type { PromptState, RuntimeMessage, ToolSchema } from "./types";

/** Recover the effective state at a branch tip or a compaction boundary. */
export function latestPromptState(messages: readonly RuntimeMessage[]): PromptState {
  const state: PromptState = {};
  for (const message of messages) Object.assign(state, message.promptState);
  return state;
}

/** The first recorded directory belongs to the initial instructions. Later revisions
 * precede the new user input or assistant reply that observed the change. A summary can supply the first revision. */
export function directoryRevisions(messages: readonly RuntimeMessage[], current?: string) {
  const revisions: { index: number; directory: string }[] = [];
  for (const [index, message] of messages.entries()) {
    const directory = message.promptState?.mcpDirectory;
    if (directory !== undefined && directory !== revisions.at(-1)?.directory) revisions.push({ index, directory });
  }
  if (current !== undefined && current !== revisions.at(-1)?.directory) revisions.push({ index: messages.length, directory: current });
  return revisions;
}

export const directoryUpdateText = (directory: string) =>
  directory || "## mcp_servers\nNo MCP servers are available for discovery.";

export function withMcpDirectory(system: string, directory?: string): string {
  return directory ? [system, directory].filter(Boolean).join("\n\n") : system;
}

export function sameTools(previous: ToolSchema[] | undefined, current: ToolSchema[]): boolean {
  return previous !== undefined && JSON.stringify(previous) === JSON.stringify(current);
}

/** Positions are immediately before the assistant reply produced by each request.
 * The live request uses messages.length. A removal starts a new declaration prefix,
 * since additional_tools has no way to revoke a previous declaration.
 */
export function toolDeclarationBatches(messages: readonly RuntimeMessage[], current: ToolSchema[]) {
  const snapshots = messages.flatMap((message, index) =>
    message.promptState?.tools ? [{ index, tools: message.promptState.tools }] : []);
  snapshots.push({ index: messages.length, tools: current });
  let head = 0;
  for (let i = 1; i < snapshots.length; i++) {
    const names = new Set(snapshots[i]!.tools.map(tool => tool.name));
    if (snapshots[i - 1]!.tools.some(tool => !names.has(tool.name))) head = i;
  }
  const initial = snapshots[head]!.tools;
  const declared = new Map(initial.map(tool => [tool.name, JSON.stringify(tool)]));
  const updates = new Map<number, ToolSchema[]>();
  for (const { index, tools } of snapshots.slice(head + 1)) {
    const added = tools.filter(tool => {
      const schema = JSON.stringify(tool);
      if (declared.get(tool.name) === schema) return false;
      declared.set(tool.name, schema);
      return true;
    });
    if (added.length) updates.set(index, added);
  }
  return { initial, updates };
}
