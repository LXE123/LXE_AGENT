import type {
  ConversationRenderItem,
  ConversationToolGroup,
  SessionMessage,
} from "../payloads";
import { isRecord } from "./content";

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

function isPureToolAssistantMessage(message: SessionMessage): boolean {
  if (roleLabel(message.role) !== "assistant") return false;
  if (!Array.isArray(message.content) || message.content.length === 0) return false;
  return message.content.every(isToolCallBlock);
}

function isToolGroupMessage(message: SessionMessage): boolean {
  return isPureToolAssistantMessage(message) || roleLabel(message.role) === "tool";
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
