import type {
  ConversationArtifactGroup,
  ConversationProcessItem,
  ConversationRenderItem,
  ConversationResponseGroup,
  ConversationToolGroup,
  SessionArtifactPayload,
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

export function toolGroupArtifacts(messages: SessionMessage[]): SessionArtifactPayload[] {
  const artifacts = messages.flatMap((message) => Array.isArray(message.artifacts) ? message.artifacts : []);
  return [...new Map(artifacts.map((artifact) => [artifact.artifact_id, artifact])).values()];
}

function renderItemArtifacts(item: ConversationRenderItem): SessionArtifactPayload[] {
  if (item.type === "artifact_group") return item.group.files;
  if (item.type === "tool_group") return toolGroupArtifacts(item.group.messages);
  if (item.type === "response_group") return toolGroupArtifacts(item.group.messages);
  return toolGroupArtifacts([
    item.message,
    ...item.toolGroups.flatMap((group) => group.messages),
  ]);
}

/**
 * Artifacts are persisted on the exact display message that was current when
 * the file was sent. A single turn can therefore expose the same artifact on
 * both sides of a tool result, or expose several batches across multiple tool
 * groups. The conversation presents one durable file section per turn, placed
 * after that turn's last artifact-bearing render item.
 */
function appendArtifactGroups(items: ConversationRenderItem[]): ConversationRenderItem[] {
  const aggregates = new Map<string, {
    group: ConversationArtifactGroup;
    ids: Set<string>;
    lastIndex: number;
  }>();

  items.forEach((item, index) => {
    for (const artifact of renderItemArtifacts(item)) {
      const turnId = String(artifact.turn_id || "").trim();
      if (!turnId) continue;
      let aggregate = aggregates.get(turnId);
      if (!aggregate) {
        aggregate = {
          group: { turnId, files: [], key: `artifacts-${turnId}` },
          ids: new Set<string>(),
          lastIndex: index,
        };
        aggregates.set(turnId, aggregate);
      }
      aggregate.lastIndex = index;
      if (!aggregate.ids.has(artifact.artifact_id)) {
        aggregate.ids.add(artifact.artifact_id);
        aggregate.group.files.push(artifact);
      }
    }
  });

  if (!aggregates.size) return items;
  const groupsAfter = new Map<number, ConversationArtifactGroup[]>();
  for (const aggregate of aggregates.values()) {
    const groups = groupsAfter.get(aggregate.lastIndex) ?? [];
    groups.push(aggregate.group);
    groupsAfter.set(aggregate.lastIndex, groups);
  }

  return items.flatMap((item, index) => [
    item,
    ...(groupsAfter.get(index) ?? []).map((group): ConversationRenderItem => ({
      type: "artifact_group",
      group,
    })),
  ]);
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

const isProcessBlock = (block: unknown): boolean =>
  blockType(block) === "thinking" || blockType(block) === "redacted_thinking";

/** Separate terminal thinking from reader-facing text so the former remains in
 * the process disclosure while the actual answer can sit outside it. */
function splitAssistantThinking(message: SessionMessage): {
  thinkingMessage: SessionMessage | null;
  message: SessionMessage;
} {
  if (roleLabel(message.role) !== "assistant" || !Array.isArray(message.content)) {
    return { thinkingMessage: null, message };
  }
  const thinking = message.content.filter(isProcessBlock);
  const spoken = message.content.filter((block) => !isProcessBlock(block));
  if (!thinking.length || !spoken.length) return { thinkingMessage: null, message };
  return {
    thinkingMessage: { ...message, content: thinking },
    message: { ...message, content: spoken },
  };
}

const hasRenderableContent = (message: SessionMessage): boolean => {
  if (typeof message.content === "string") return Boolean(message.content.trim());
  if (Array.isArray(message.content)) return message.content.length > 0;
  return message.content !== undefined || message.tool_calls !== undefined;
};

const containsToolCall = (message: SessionMessage): boolean =>
  toolCallBlocks(message).length > 0 || message.tool_calls !== undefined;

function buildResponseGroup(
  messages: SessionMessage[],
  displayGroupId: string,
  startIndex: number,
): ConversationResponseGroup {
  const turn = messages.find((message) => message.turn)?.turn;
  const terminalIsReply = turn?.status !== "error" && turn?.status !== "cancelled";
  const finalIndex = terminalIsReply
    ? messages.reduce((candidate, message, index) =>
      roleLabel(message.role) === "assistant" && hasReaderFacingText(message) && !containsToolCall(message)
        ? index
        : candidate, -1)
    : -1;
  const process: ConversationProcessItem[] = [];
  let finalMessage: SessionMessage | undefined;
  let pendingTools: SessionMessage[] = [];
  let toolOrdinal = 0;
  const flushTools = (): void => {
    if (!pendingTools.length) return;
    process.push({
      type: "tool_group",
      group: {
        messages: pendingTools,
        startIndex,
        key: `tools-${displayGroupId}-${toolOrdinal}`,
      },
    });
    toolOrdinal += 1;
    pendingTools = [];
  };

  messages.forEach((message, index) => {
    if (roleLabel(message.role) === "tool") {
      pendingTools.push(message);
      return;
    }
    flushTools();
    const split = splitAssistantInlineToolCalls(message);
    const thought = splitAssistantThinking(split.message);
    if (index === finalIndex) {
      if (thought.thinkingMessage) {
        process.push({
          type: "message",
          message: thought.thinkingMessage,
          key: `process-${displayGroupId}-${index}-thinking`,
        });
      }
      if (hasReaderFacingText(thought.message)) finalMessage = thought.message;
    } else if (hasRenderableContent(split.message)) {
      process.push({
        type: "message",
        message: split.message,
        key: `process-${displayGroupId}-${index}`,
      });
    }
    if (split.toolCallMessage) pendingTools.push(split.toolCallMessage);
  });
  flushTools();

  return {
    displayGroupId,
    messages,
    process,
    ...(finalMessage ? { finalMessage } : {}),
    ...(turn ? { turn } : {}),
    key: `response-${displayGroupId}`,
  };
}

export function buildConversationItems(messages: SessionMessage[]): ConversationRenderItem[] {
  const items: ConversationRenderItem[] = [];
  for (let index = 0; index < messages.length;) {
    const message = messages[index]!;
    const displayGroupId = String(message.display_group_id || `legacy-${index}`);
    let end = index + 1;
    while (end < messages.length && messages[end]?.display_group_id === message.display_group_id) end += 1;
    const displayMessages = messages.slice(index, end);
    const roles = displayMessages.map((entry) => roleLabel(entry.role));
    if (roles.some((role) => role === "assistant") && roles.every((role) => role === "assistant" || role === "tool")) {
      items.push({ type: "response_group", group: buildResponseGroup(displayMessages, displayGroupId, index) });
    } else if (displayMessages.every(isToolGroupMessage)) {
      items.push({
        type: "tool_group",
        group: { messages: displayMessages, startIndex: index, key: `tools-${displayGroupId}` },
      });
    } else {
      displayMessages.forEach((entry, offset) => {
        items.push({ type: "message", message: entry, index: index + offset, toolGroups: [] });
      });
    }
    index = end;
  }
  return appendArtifactGroups(items);
}
