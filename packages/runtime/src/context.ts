import type { RuntimeMessage, ToolResultBlock, ToolUseBlock } from "./types";

const blocks = (message: RuntimeMessage): Array<Record<string, unknown>> =>
  Array.isArray(message.content) ? message.content : [];

const isToolUse = (value: Record<string, unknown>): value is ToolUseBlock =>
  value.type === "tool_use" && typeof value.id === "string";

const isToolResult = (value: Record<string, unknown>): value is ToolResultBlock =>
  value.type === "tool_result" && typeof value.tool_use_id === "string";

export function validateToolCallClosure(messages: readonly RuntimeMessage[]): void {
  const pending = new Set<string>();
  for (const message of messages) {
    for (const block of blocks(message)) {
      if (isToolUse(block)) {
        if (message.role !== "assistant") throw new Error(`tool_use must be assistant content: ${block.id}`);
        pending.add(block.id);
      }
      if (isToolResult(block)) {
        if (message.role !== "user") throw new Error(`tool_result must be user content: ${block.tool_use_id}`);
        if (!pending.delete(block.tool_use_id)) throw new Error(`orphaned tool_result: ${block.tool_use_id}`);
      }
    }
  }
  if (pending.size > 0) throw new Error(`unclosed tool_use: ${[...pending].join(", ")}`);
}

const startsWithToolResult = (message: RuntimeMessage | undefined): boolean =>
  Boolean(message && blocks(message).some(isToolResult));

export function pruneMessages(messages: readonly RuntimeMessage[], maxMessages: number): RuntimeMessage[] {
  const limit = Math.max(1, Math.trunc(maxMessages));
  if (messages.length <= limit) {
    validateToolCallClosure(messages);
    return structuredClone(messages) as RuntimeMessage[];
  }
  const preferred = messages.length - limit;
  for (let start = preferred; start >= 0; start -= 1) {
    const candidate = messages.slice(start);
    if (candidate[0]?.role !== "user" || startsWithToolResult(candidate[0])) continue;
    try {
      validateToolCallClosure(candidate);
      return structuredClone(candidate) as RuntimeMessage[];
    } catch {
      // Expand backward until the complete tool exchange is included.
    }
  }
  validateToolCallClosure(messages);
  return structuredClone(messages) as RuntimeMessage[];
}
