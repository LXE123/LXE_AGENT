import type {
  ConversationArtifactGroup,
  ConversationLiveProcessItem,
  ConversationProcessItem,
  ConversationRenderItem,
  ConversationResponseGroup,
  ConversationToolGroup,
  SessionArtifactPayload,
  SessionMessage,
  DesktopConversationStreamPayload,
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
  action: ToolAction;
  target: string;
  status: "running" | "success" | "error";
  expandable?: boolean;
  call: unknown;
  result: unknown;
}

/** A live row is only expandable when the stream contains real output. */
export function hasLiveToolOperationDetails(step: unknown): boolean {
  if (!isRecord(step)) return false;
  const result = isRecord(step.result_block) ? String(step.result_block.content ?? "").trim() : "";
  const error = isRecord(step.error_block) ? String(step.error_block.content ?? "").trim() : "";
  return Boolean(result || error);
}

export type ToolAction =
  | "read"
  | "edit"
  | "write"
  | "search"
  | "list"
  | "run"
  | "send"
  | "web"
  | "tool";

export type ToolActionLabels = Record<ToolAction, string>;

export interface ToolBatchSummaryLabels {
  actions: ToolActionLabels;
  more: (count: number) => string;
  failures: (count: number) => string;
}

export interface ToolBatchSummary {
  text: string;
  errorCount: number;
  operationCount: number;
}

const TOOL_ACTIONS: Record<string, ToolAction> = {
  read: "read",
  read_file: "read",
  edit: "edit",
  edit_file: "edit",
  write: "write",
  write_file: "write",
  grep: "search",
  find: "search",
  search: "search",
  tool_search: "search",
  ls: "list",
  list: "list",
  list_files: "list",
  exec: "run",
  process: "run",
  send_file: "send",
  send_files: "send",
  web_search: "web",
  web_fetch: "web",
};

const fileBasename = (value: string): string => {
  const normalized = value.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized.split("/").at(-1) || normalized;
};

export function toolOperationPresentation(name: string, argument: string): {
  action: ToolAction;
  target: string;
} {
  const normalizedName = name.trim().toLowerCase();
  const action = TOOL_ACTIONS[normalizedName] ?? "tool";
  if (action === "tool") return { action, target: name.trim() || "tool" };
  if (["read", "edit", "write", "list", "send"].includes(action)) {
    return { action, target: fileBasename(argument) };
  }
  return { action, target: argument.trim() };
}

/** Build a stable, local summary without asking the model to narrate its own tools. */
export function summarizeToolOperations(
  operations: ToolOperation[],
  labels: ToolBatchSummaryLabels,
): ToolBatchSummary {
  const grouped = new Map<ToolAction, { action: ToolAction; count: number; targets: Set<string> }>();
  for (const operation of operations) {
    const current = grouped.get(operation.action);
    if (current) {
      current.count += 1;
      if (operation.target) current.targets.add(operation.target);
    } else {
      grouped.set(operation.action, {
        action: operation.action,
        count: 1,
        targets: new Set(operation.target ? [operation.target] : []),
      });
    }
  }

  const groups = [...grouped.values()];
  const shown = groups.slice(0, 3);
  const segments = shown.map((group) => {
    const oneTarget = group.targets.size === 1 ? [...group.targets][0] : "";
    const target = group.count === 1 || oneTarget ? oneTarget : "";
    return [labels.actions[group.action], target, group.count > 1 ? `×${group.count}` : ""]
      .filter(Boolean).join(" ");
  });
  const hiddenCount = groups.slice(3).reduce((total, group) => total + group.count, 0);
  if (hiddenCount > 0) segments.push(labels.more(hiddenCount));
  const errorCount = operations.filter((operation) => operation.status === "error").length;
  if (errorCount > 0) segments.push(labels.failures(errorCount));
  return {
    text: segments.join(" · "),
    errorCount,
    operationCount: operations.length,
  };
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

/**
 * Splits a call's input into the one value that describes it — the command, the
 * path, the query — and everything else, so the detail view can lead with the
 * former instead of printing the whole input object as JSON.
 */
export function splitCallArguments(call: unknown): { primary: string; rest: Record<string, unknown> } {
  if (!isRecord(call)) return { primary: "", rest: {} };
  const input = call.input ?? call.arguments;
  if (!isRecord(input)) return { primary: scalarText(input), rest: {} };
  const keys = Object.keys(input);
  const primaryKey = OPERATION_ARGUMENT_KEYS.find((key) => scalarText(input[key]))
    ?? keys.find((key) => scalarText(input[key]))
    ?? "";
  const rest: Record<string, unknown> = {};
  for (const key of keys) {
    if (key !== primaryKey) rest[key] = input[key];
  }
  return { primary: primaryKey ? scalarText(input[primaryKey]) : "", rest };
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
    const name = (isRecord(call) ? scalarText(call.name) : "") || "tool";
    const argument = operationArgument(call);
    return {
      key: callId || `call-${index}`,
      name,
      argument,
      ...toolOperationPresentation(name, argument),
      status: isRecord(result) && result.is_error ? "error" : "success",
      call,
      result,
    };
  });
  unclaimed.forEach((result, index) => {
    const name = (isRecord(result) ? scalarText(result.tool_name) : "") || "tool";
    operations.push({
      key: blockId(result, ["tool_call_id", "tool_use_id"]) || `result-${index}`,
      name,
      argument: "",
      ...toolOperationPresentation(name, ""),
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
    const previous = process.at(-1);
    if (previous?.type === "tool_group") {
      previous.group.messages.push(...pendingTools);
    } else {
      process.push({
        type: "tool_group",
        group: {
          messages: pendingTools,
          startIndex,
          key: `tools-${displayGroupId}-${toolOrdinal}`,
        },
      });
      toolOrdinal += 1;
    }
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

export function buildLiveProcessItems(
  parts: DesktopConversationStreamPayload["process_parts"],
): ConversationLiveProcessItem[] {
  const items: ConversationLiveProcessItem[] = [];
  const ordered = [...parts].sort((left, right) => left.sequence - right.sequence);
  for (const part of ordered) {
    if (part.type === "text" && part.presentation === "final") continue;
    if (part.type === "tool") {
      const previous = items.at(-1);
      if (previous?.type === "tool_group") previous.group.parts.push(part);
      else items.push({
        type: "tool_group",
        group: { parts: [part], key: `live-tools-${part.part_id}` },
      });
      continue;
    }
    const content = part.type === "thinking"
      ? [
          ...(part.text ? [{ type: "thinking", thinking: part.text }] : []),
          ...Array.from({ length: part.redacted_count }, () => ({ type: "redacted_thinking" })),
        ]
      : [{ type: "text", text: part.text }];
    items.push({
      type: "message",
      message: {
        role: "assistant",
        content,
        display_group_id: `live-${part.part_id}`,
      },
      key: `live-${part.part_id}`,
    });
  }
  return items;
}

export function liveFinalText(parts: DesktopConversationStreamPayload["process_parts"]): string {
  return [...parts]
    .sort((left, right) => left.sequence - right.sequence)
    .filter((part): part is Extract<typeof part, { type: "text" }> =>
      part.type === "text" && part.presentation === "final")
    .map((part) => part.text)
    .join("");
}
