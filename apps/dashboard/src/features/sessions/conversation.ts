import type {
  ConversationRenderItem,
  ConversationToolGroup,
  SessionMessage,
} from "../../api/payloads";
import { isRecord } from "../../shared/content";

export function roleLabel(role: string): string {
  const normalized = String(role || "unknown").toLowerCase();
  return ["user", "assistant", "tool", "system"].includes(normalized) ? normalized : "unknown";
}

export function blockType(block: unknown): string {
  return isRecord(block) ? String(block.type || "") : "";
}

export function isToolCallBlock(block: unknown): boolean {
  const type = blockType(block);
  return type === "tool_use" || type === "tool_call";
}

export function isToolResultBlock(block: unknown): boolean {
  return blockType(block) === "tool_result";
}

export function toolCallBlocks(message: SessionMessage): unknown[] {
  return Array.isArray(message.content) ? message.content.filter(isToolCallBlock) : [];
}

export function toolResultBlocks(message: SessionMessage): unknown[] {
  return Array.isArray(message.content) ? message.content.filter(isToolResultBlock) : [];
}

function isReaderFacingTextBlock(block: unknown): boolean {
  return blockType(block) === "text" && Boolean(isRecord(block) && String(block.text ?? "").trim());
}

/**
 * Whether the message says anything the reader is meant to read. Thinking and
 * tool calls do not count: a message made only of those is how the answer was
 * reached, and the view strips it of the card chrome an actual reply gets.
 */
export function hasReaderFacingText(message: SessionMessage): boolean {
  if (typeof message.content === "string") return Boolean(message.content.trim());
  if (!Array.isArray(message.content)) return false;
  return message.content.some(isReaderFacingTextBlock);
}

function isPureToolAssistantMessage(message: SessionMessage): boolean {
  if (roleLabel(message.role) !== "assistant") return false;
  if (!Array.isArray(message.content) || message.content.length === 0) return false;
  return message.content.every(isToolCallBlock);
}

function isToolGroupMessage(message: SessionMessage): boolean {
  return isPureToolAssistantMessage(message) || roleLabel(message.role) === "tool";
}

export function hasToolError(messages: SessionMessage[]): boolean {
  return messages.some((message) =>
    toolResultBlocks(message).some((result) => isRecord(result) && result.is_error));
}

export interface ToolOperation {
  key: string;
  name: string;
  argument: string;
  status: "success" | "error";
  call: unknown;
  result: unknown;
}

/**
 * Keys that usually carry the one value identifying what a call did, ordered to
 * match how the runtime's own tool descriptors rank them: a search is described
 * by what it looked for, not by where it looked.
 */
const OPERATION_ARGUMENT_KEYS = [
  "command", "pattern", "query", "url", "path", "file_path", "action", "name",
];

const scalarText = (value: unknown): string =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value).trim()
    : "";

function operationArgument(call: unknown): string {
  if (!isRecord(call)) return "";
  const input = call.input ?? call.arguments;
  if (!isRecord(input)) return scalarText(input);
  for (const key of OPERATION_ARGUMENT_KEYS) {
    const value = scalarText(input[key]);
    if (value) return value;
  }
  for (const value of Object.values(input)) {
    const text = scalarText(value);
    if (text) return text;
  }
  return "";
}

const blockId = (block: unknown, keys: string[]): string => {
  if (!isRecord(block)) return "";
  for (const key of keys) {
    const value = scalarText(block[key]);
    if (value) return value;
  }
  return "";
};

/**
 * Pairs each call in a group with the result it produced so the expanded group
 * can list one line per operation instead of dumping every message in full.
 * Results that match no call still get a line - dropping them would hide a
 * failure.
 */
export function toolOperations(messages: SessionMessage[]): ToolOperation[] {
  const calls: unknown[] = [];
  const results: unknown[] = [];
  for (const message of messages) {
    calls.push(...toolCallBlocks(message));
    const own = toolResultBlocks(message);
    if (own.length) results.push(...own);
    else if (roleLabel(message.role) === "tool") results.push({ type: "tool_result", ...message });
  }

  const unclaimed = [...results];
  const take = (callId: string): unknown => {
    const index = callId
      ? unclaimed.findIndex((result) => blockId(result, ["tool_call_id", "tool_use_id"]) === callId)
      : -1;
    const at = index >= 0 ? index : (callId ? -1 : 0);
    if (at < 0 || at >= unclaimed.length) return undefined;
    return unclaimed.splice(at, 1)[0];
  };

  const operations: ToolOperation[] = calls.map((call, index) => {
    const callId = blockId(call, ["id", "tool_call_id", "tool_use_id"]);
    const result = take(callId);
    return {
      key: callId || `call-${index}`,
      name: (isRecord(call) ? scalarText(call.name) : "") || "tool",
      argument: operationArgument(call),
      status: isRecord(result) && result.is_error ? "error" : "success",
      call,
      result,
    };
  });
  unclaimed.forEach((result, index) => {
    operations.push({
      key: blockId(result, ["tool_call_id", "tool_use_id"]) || `result-${index}`,
      name: (isRecord(result) ? scalarText(result.tool_name) : "") || "tool",
      argument: "",
      status: isRecord(result) && result.is_error ? "error" : "success",
      call: undefined,
      result,
    });
  });
  return operations;
}

function splitAssistantInlineToolCalls(message: SessionMessage): {
  message: SessionMessage;
  toolCallMessage: SessionMessage | null;
} {
  if (roleLabel(message.role) !== "assistant") return { message, toolCallMessage: null };
  const content = message.content;
  const contentToolCalls = Array.isArray(content) ? content.filter(isToolCallBlock) : [];
  const nonToolContent = Array.isArray(content) ? content.filter((block) => !isToolCallBlock(block)) : null;
  const hasFallbackToolCalls = message.tool_calls !== undefined && message.tool_calls !== null;
  if (!contentToolCalls.length && !hasFallbackToolCalls) return { message, toolCallMessage: null };

  const visibleMessage: SessionMessage = { ...message };
  if (nonToolContent) {
    if (nonToolContent.length) visibleMessage.content = nonToolContent;
    else delete visibleMessage.content;
  }
  delete visibleMessage.tool_calls;
  const toolContent = [...contentToolCalls];
  if (!contentToolCalls.length && hasFallbackToolCalls) {
    toolContent.push({ type: "tool_call", name: "__tool_calls__", input: message.tool_calls });
  }
  const toolCallMessage: SessionMessage = { ...message, content: toolContent };
  delete toolCallMessage.tool_calls;
  return { message: visibleMessage, toolCallMessage };
}

export function buildConversationItems(messages: SessionMessage[]): ConversationRenderItem[] {
  const items: ConversationRenderItem[] = [];
  let pending: SessionMessage[] = [];
  let pendingStart = 0;
  const flushPending = (): void => {
    if (!pending.length) return;
    const group: ConversationToolGroup = {
      messages: pending,
      startIndex: pendingStart,
      key: `tools-${pendingStart}-${pending.length}`,
    };
    const previous = items[items.length - 1];
    if (previous?.type === "message" && roleLabel(previous.message.role) === "assistant") {
      const existingGroup = previous.toolGroups[previous.toolGroups.length - 1];
      if (existingGroup) existingGroup.messages.push(...pending);
      else previous.toolGroups.push(group);
    } else {
      items.push({ type: "tool_group", group });
    }
    pending = [];
  };

  messages.forEach((message, index) => {
    if (isToolGroupMessage(message)) {
      if (!pending.length) pendingStart = index;
      pending.push(message);
      return;
    }
    flushPending();
    const split = splitAssistantInlineToolCalls(message);
    const item: Extract<ConversationRenderItem, { type: "message" }> = {
      type: "message",
      message: split.message,
      index,
      toolGroups: [],
    };
    if (split.toolCallMessage) {
      item.toolGroups.push({
        messages: [split.toolCallMessage],
        startIndex: index,
        key: `tools-${index}-inline`,
      });
    }
    items.push(item);
  });
  flushPending();
  return items;
}
