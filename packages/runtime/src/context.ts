import type { JsonObject, JsonValue } from "@lxe/protocol";
import { createLogger } from "@lxe/core";
import type {
  RuntimeMessage,
  RuntimeProvider,
  RuntimeStore,
  RuntimeUsage,
  ToolResultBlock,
  ToolSchema,
  ToolUseBlock,
} from "./types";

export const IMAGE_TOKEN_ESTIMATE = 1_600;
export const RECENT_RAW_TURN_TOKEN_LIMIT = 20_000;
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 256_000;
export const DEFAULT_RESERVE_TOKENS = 20_000;
export const STEP_TOOL_RESULT_MAX_TOKENS = 10_000;
export const SUMMARY_COMPACTION_MAX_ATTEMPTS = 2;
export const PRECALL_COMPACTION_USAGE_THRESHOLD = 0.9;

const MISSING_TOOL_RESULT_STUB = "[Result unavailable — see context summary above]";
const THINKING_SUMMARY_PLACEHOLDER = "[assistant thinking omitted]";
const REDACTED_THINKING_SUMMARY_PLACEHOLDER = "[assistant redacted thinking omitted]";
const PROCESSED_IMAGE_PLACEHOLDER = "[image data removed - already processed by model]";

const HISTORY_SUMMARY_PROMPT = `The messages below are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish?]

## Constraints & Preferences
- [Important user constraints and preferences, or "(none)"]

## Progress
### Done
- [x] [Completed work]

### In Progress
- [ ] [Current work]

### Blocked
- [Blocking issues, or "(none)"]

## Key Decisions
- **[Decision]**: [Rationale]

## Next Steps
1. [Ordered next action]

## Critical Context
- [Exact paths, identifiers, errors, and facts needed to continue]

Keep every section concise. Preserve exact file paths, function names, identifiers, and error messages.`;

const MIDTURN_SUMMARY_PROMPT = `The messages below are intermediate steps from the current user task. Create a checkpoint summary that another LLM will use to continue the same task.

Use this EXACT format:

## Original Request
- Quote the original request verbatim.

## Completed Steps
- Preserve completed actions, exact paths, identifiers, tool names, and errors.

## Omitted Raw Tool Results
- State what raw content was omitted and how to re-fetch it.
- State that omitted content must be re-read before being relied on.

## Current State
- Describe what remains to do next.

Keep it concise but operationally precise.`;

const emptyUsage = (): RuntimeUsage => ({
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
});

const addUsage = (target: RuntimeUsage, source: RuntimeUsage): void => {
  target.input_tokens += Math.max(0, Math.trunc(source.input_tokens ?? 0));
  target.output_tokens += Math.max(0, Math.trunc(source.output_tokens ?? 0));
  target.cache_read_input_tokens = Math.max(0, Math.trunc(target.cache_read_input_tokens ?? 0)) +
    Math.max(0, Math.trunc(source.cache_read_input_tokens ?? 0));
  target.cache_creation_input_tokens = Math.max(0, Math.trunc(target.cache_creation_input_tokens ?? 0)) +
    Math.max(0, Math.trunc(source.cache_creation_input_tokens ?? 0));
};

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

const jsonObject = (value: unknown): JsonObject => structuredClone(object(value)) as JsonObject;
const text = (value: unknown): string => String(value ?? "");
const blocks = (message: RuntimeMessage): Array<Record<string, unknown>> =>
  Array.isArray(message.content) ? message.content.map(object) : [];

const isToolUse = (value: Record<string, unknown>): value is ToolUseBlock =>
  value.type === "tool_use" && typeof value.id === "string";

const isToolResult = (value: Record<string, unknown>): value is ToolResultBlock =>
  value.type === "tool_result" && typeof value.tool_use_id === "string";

const isImageBlock = (value: unknown): boolean => object(value).type === "image";

const replaceImagesForEstimate = (value: unknown): { value: unknown; images: number } => {
  if (isImageBlock(value)) {
    return {
      value: { type: "image", source: { type: "base64", media_type: "", data: "[image omitted]" } },
      images: 1,
    };
  }
  if (Array.isArray(value)) {
    let images = 0;
    const items = value.map((item) => {
      const replaced = replaceImagesForEstimate(item);
      images += replaced.images;
      return replaced.value;
    });
    return { value: items, images };
  }
  if (value !== null && typeof value === "object") {
    let images = 0;
    const entries = Object.entries(value as Record<string, unknown>).map(([key, item]) => {
      const replaced = replaceImagesForEstimate(item);
      images += replaced.images;
      return [key, replaced.value] as const;
    });
    return { value: Object.fromEntries(entries), images };
  }
  return { value, images: 0 };
};

const estimateTextTokens = (value: string): number => Math.ceil(Buffer.byteLength(value, "utf8") / 4);

export function estimateTokens(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (typeof value === "string") return estimateTextTokens(value);
  if (isImageBlock(value)) return IMAGE_TOKEN_ESTIMATE;
  const replaced = replaceImagesForEstimate(value);
  let serialized = "";
  try { serialized = JSON.stringify(replaced.value); } catch { serialized = String(replaced.value); }
  return estimateTextTokens(serialized) + replaced.images * IMAGE_TOKEN_ESTIMATE;
}

export function requestContextTokenEstimate(
  systemPrompt: string,
  messages: readonly RuntimeMessage[],
  toolSchemas: readonly ToolSchema[] = [],
): number {
  return estimateTokens(systemPrompt) +
    messages.reduce((total, message) => total + estimateTokens(message), 0) +
    estimateTokens(toolSchemas);
}

const cleanBlock = (raw: unknown, role: RuntimeMessage["role"]): JsonObject | undefined => {
  const block = object(raw);
  const type = String(block.type ?? "").trim();
  if (type === "text") return { type, text: text(block.text) };
  if (type === "image" && role === "user") return jsonObject(block);
  if (type === "thinking" && role === "assistant") {
    return { type, thinking: text(block.thinking), signature: text(block.signature) };
  }
  if (type === "redacted_thinking" && role === "assistant") {
    return { type, data: text(block.data) };
  }
  if (type === "tool_use" && role === "assistant") {
    const id = text(block.id).trim();
    const name = text(block.name).trim();
    if (!id || !name) return undefined;
    return { type, id, name, input: jsonObject(block.input) };
  }
  if (type === "tool_result" && role === "user") {
    const toolUseId = text(block.tool_use_id ?? block.tool_call_id).trim();
    if (!toolUseId) return undefined;
    const content = Array.isArray(block.content)
      ? block.content.map((item) => jsonObject(item))
      : text(block.content);
    return {
      type,
      tool_use_id: toolUseId,
      content,
      ...(block.is_error === true ? { is_error: true } : {}),
    };
  }
  return undefined;
};

export function cleanCanonicalMessages(messages: readonly RuntimeMessage[]): RuntimeMessage[] {
  const cleaned: RuntimeMessage[] = [];
  for (const raw of messages) {
    const role = raw?.role;
    if (role !== "user" && role !== "assistant") continue;
    if (!Array.isArray(raw.content)) {
      cleaned.push(role === "assistant"
        ? { role, content: [{ type: "text", text: text(raw.content) }] }
        : { role, content: text(raw.content) });
      continue;
    }
    const content = raw.content.map((block) => cleanBlock(block, role)).filter((block): block is JsonObject => Boolean(block));
    if (content.length > 0) cleaned.push({ role, content });
  }
  return cleaned;
}

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

export function sanitizeMessagesForProvider(messages: readonly RuntimeMessage[]): {
  messages: RuntimeMessage[];
  changed: boolean;
} {
  const original = JSON.stringify(messages);
  const cleaned = cleanCanonicalMessages(messages);
  const pending = new Set<string>();
  const repaired: RuntimeMessage[] = [];

  for (const message of cleaned) {
    if (message.role === "assistant") {
      for (const block of blocks(message)) if (isToolUse(block)) pending.add(block.id);
      repaired.push(message);
      continue;
    }
    if (!Array.isArray(message.content)) {
      repaired.push(message);
      continue;
    }
    const content = message.content.filter((rawBlock) => {
      const block = object(rawBlock);
      if (!isToolResult(block)) return true;
      if (!pending.has(block.tool_use_id)) return false;
      pending.delete(block.tool_use_id);
      return true;
    });
    if (content.length > 0) repaired.push({ role: "user", content });
  }

  if (pending.size > 0) {
    const closed: RuntimeMessage[] = [];
    for (const message of repaired) {
      closed.push(message);
      if (message.role !== "assistant") continue;
      const missing = blocks(message)
        .filter(isToolUse)
        .filter((block) => pending.delete(block.id))
        .map((block): ToolResultBlock => ({
          type: "tool_result",
          tool_use_id: block.id,
          content: MISSING_TOOL_RESULT_STUB,
          is_error: true,
        }));
      if (missing.length > 0) closed.push({ role: "user", content: missing });
    }
    validateToolCallClosure(closed);
    return { messages: closed, changed: JSON.stringify(closed) !== original };
  }

  validateToolCallClosure(repaired);
  return { messages: repaired, changed: JSON.stringify(repaired) !== original };
}

const decodeUtf8Boundary = (bytes: Uint8Array, fromEnd: boolean): string => {
  for (let trim = 0; trim <= 3 && trim <= bytes.length; trim += 1) {
    const candidate = fromEnd ? bytes.subarray(trim) : bytes.subarray(0, bytes.length - trim);
    try { return new TextDecoder("utf-8", { fatal: true }).decode(candidate); } catch { /* try next boundary */ }
  }
  return "";
};

export function trimTextToTokenBudget(value: string, maxTokens: number): { text: string; trimmed: boolean } {
  const safeMax = Math.max(1, Math.trunc(maxTokens));
  const source = String(value ?? "");
  const bytes = Buffer.from(source, "utf8");
  const maxBytes = safeMax * 4;
  if (bytes.length <= maxBytes) return { text: source, trimmed: false };
  const removedTokens = Math.max(1, estimateTokens(source) - safeMax);
  const marker = `\n…${removedTokens} tokens truncated…\n`;
  const budget = Math.max(0, maxBytes - Buffer.byteLength(marker, "utf8"));
  const leftSize = Math.floor(budget / 2);
  const rightSize = budget - leftSize;
  const prefix = decodeUtf8Boundary(bytes.subarray(0, leftSize), false);
  const suffix = decodeUtf8Boundary(bytes.subarray(bytes.length - rightSize), true);
  return { text: `${prefix}${marker}${suffix}`, trimmed: true };
}

const trimInlineContent = (content: JsonObject[], maxTokens: number): { content: JsonObject[]; trimmed: boolean } => {
  const combined = content
    .filter((block) => block.type === "text")
    .map((block) => text(block.text))
    .filter(Boolean)
    .join("\n");
  if (!combined) return { content: structuredClone(content), trimmed: false };
  const result = trimTextToTokenBudget(combined, maxTokens);
  if (!result.trimmed) return { content: structuredClone(content), trimmed: false };
  let inserted = false;
  const next: JsonObject[] = [];
  for (const block of content) {
    if (block.type === "text") {
      if (!inserted) next.push({ type: "text", text: result.text });
      inserted = true;
    } else next.push(structuredClone(block));
  }
  if (!inserted) next.unshift({ type: "text", text: result.text });
  return { content: next, trimmed: true };
};

export function trimToolResultBlocks(
  results: readonly ToolResultBlock[],
  maxTokens = STEP_TOOL_RESULT_MAX_TOKENS,
): { results: ToolResultBlock[]; changed: boolean } {
  let changed = false;
  const next = results.map((result): ToolResultBlock => {
    if (Array.isArray(result.content)) {
      const trimmed = trimInlineContent(result.content, maxTokens);
      changed ||= trimmed.trimmed;
      return { ...result, content: trimmed.content };
    }
    const trimmed = trimTextToTokenBudget(result.content, maxTokens);
    changed ||= trimmed.trimmed;
    return { ...result, content: trimmed.text };
  });
  return { results: next, changed };
}

const replaceImages = (content: RuntimeMessage["content"]): { content: RuntimeMessage["content"]; changed: boolean } => {
  if (!Array.isArray(content)) return { content, changed: false };
  let changed = false;
  const next = content.map((rawBlock): JsonObject => {
    const block = jsonObject(rawBlock);
    if (block.type === "image") {
      changed = true;
      return { type: "text", text: PROCESSED_IMAGE_PLACEHOLDER };
    }
    if (block.type === "tool_result" && Array.isArray(block.content)) {
      const nested = block.content.map((item): JsonValue => {
        const child = object(item);
        if (child.type === "image") {
          changed = true;
          return { type: "text", text: PROCESSED_IMAGE_PLACEHOLDER };
        }
        return jsonObject(child);
      });
      return { ...block, content: nested };
    }
    return block;
  });
  return { content: next, changed };
};

export function pruneProcessedHistoryImages(messages: readonly RuntimeMessage[]): {
  messages: RuntimeMessage[];
  changed: boolean;
} {
  let changed = false;
  const next = messages.map((message): RuntimeMessage => {
    const replaced = replaceImages(message.content);
    changed ||= replaced.changed;
    return { role: message.role, content: replaced.content };
  });
  return { messages: next, changed };
}

const startsWithToolResult = (message: RuntimeMessage): boolean => blocks(message).some(isToolResult);
const isConversationUser = (message: RuntimeMessage): boolean => message.role === "user" && !startsWithToolResult(message);

const turnSpans = (messages: readonly RuntimeMessage[]): Array<[number, number]> => {
  if (messages.length === 0) return [];
  const starts: number[] = [];
  messages.forEach((message, index) => { if (isConversationUser(message)) starts.push(index); });
  if (starts.length === 0) return [[0, messages.length]];
  if (starts[0] !== 0) starts.unshift(0);
  return starts.map((start, index) => [start, starts[index + 1] ?? messages.length]);
};

const selectRecentTurns = (
  messages: readonly RuntimeMessage[],
  recentRawTokens: number,
): { compacted: RuntimeMessage[]; retained: RuntimeMessage[] } => {
  const spans = turnSpans(messages);
  let keepStart = 0;
  let consumed = 0;
  for (let index = spans.length - 1; index >= 0; index -= 1) {
    const [start, end] = spans[index]!;
    const size = estimateTokens(messages.slice(start, end));
    if (consumed > 0 && consumed + size > recentRawTokens) break;
    keepStart = start;
    consumed += size;
    if (consumed >= recentRawTokens) break;
  }
  return {
    compacted: structuredClone(messages.slice(0, keepStart)) as RuntimeMessage[],
    retained: structuredClone(messages.slice(keepStart)) as RuntimeMessage[],
  };
};

const latestUserStart = (messages: readonly RuntimeMessage[]): number => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isConversationUser(messages[index]!)) return index;
  }
  return 0;
};

const stepSpans = (messages: readonly RuntimeMessage[], start: number): Array<[number, number]> => {
  const spans: Array<[number, number]> = [];
  let current: number | undefined;
  for (let index = start; index < messages.length; index += 1) {
    if (messages[index]!.role === "assistant") {
      if (current !== undefined) spans.push([current, index]);
      current = index;
    } else if (current === undefined) current = index;
  }
  if (current !== undefined) spans.push([current, messages.length]);
  return spans;
};

interface MidturnPlan {
  prefix: RuntimeMessage[];
  originalUserMessage: RuntimeMessage;
  compacted: RuntimeMessage[];
  retained: RuntimeMessage[];
}

const selectMidturnPlan = (messages: readonly RuntimeMessage[], recentRawTokens: number): MidturnPlan | undefined => {
  const userStart = latestUserStart(messages);
  const original = messages[userStart];
  if (!original || !isConversationUser(original) || userStart >= messages.length - 1) return undefined;
  const spans = stepSpans(messages, userStart + 1);
  if (spans.length === 0) return undefined;
  let keepIndex = spans.length;
  let consumed = 0;
  for (let index = spans.length - 1; index >= 0; index -= 1) {
    const [start, end] = spans[index]!;
    const size = estimateTokens(messages.slice(start, end));
    if (consumed > 0 && consumed + size > recentRawTokens) break;
    keepIndex = index;
    consumed += size;
    if (consumed >= recentRawTokens) break;
  }
  let compactedSpans = spans.slice(0, keepIndex);
  if (compactedSpans.length === 0 && spans.length === 1 && estimateTokens(messages.slice(spans[0]![0], spans[0]![1])) > recentRawTokens) {
    compactedSpans = spans;
    keepIndex = spans.length;
  }
  if (compactedSpans.length === 0) return undefined;
  const compactStart = compactedSpans[0]![0];
  const compactEnd = compactedSpans.at(-1)![1];
  const retainedStart = keepIndex < spans.length ? spans[keepIndex]![0] : messages.length;
  return {
    prefix: structuredClone(messages.slice(0, userStart)) as RuntimeMessage[],
    originalUserMessage: structuredClone(original) as RuntimeMessage,
    compacted: structuredClone(messages.slice(compactStart, compactEnd)) as RuntimeMessage[],
    retained: structuredClone(messages.slice(retainedStart)) as RuntimeMessage[],
  };
};

const userText = (content: RuntimeMessage["content"]): string => {
  if (typeof content === "string") return content.trim();
  return content.map((raw) => {
    const block = object(raw);
    if (block.type === "text") return text(block.text).trim();
    if (block.type === "image") return "[image omitted]";
    return "";
  }).filter(Boolean).join("\n");
};

const renderSummaryTranscript = (messages: readonly RuntimeMessage[]): string => {
  const lines: string[] = [];
  turnSpans(messages).forEach(([start, end], turnIndex) => {
    lines.push(`### Turn ${turnIndex + 1}`);
    for (const message of messages.slice(start, end)) {
      if (message.role === "user" && !startsWithToolResult(message)) {
        const value = userText(message.content);
        if (value) lines.push(`User: ${value}`);
        continue;
      }
      if (message.role === "assistant") {
        if (typeof message.content === "string") {
          if (message.content.trim()) lines.push(`Assistant: ${message.content.trim()}`);
          continue;
        }
        const textParts: string[] = [];
        for (const block of blocks(message)) {
          if (block.type === "thinking") lines.push(`Assistant Thinking: ${THINKING_SUMMARY_PLACEHOLDER}`);
          else if (block.type === "redacted_thinking") lines.push(`Assistant Thinking: ${REDACTED_THINKING_SUMMARY_PLACEHOLDER}`);
          else if (block.type === "text" && text(block.text).trim()) textParts.push(text(block.text).trim());
          else if (isToolUse(block)) lines.push(`Assistant Tool Call: ${block.name} ${JSON.stringify(block.input)}`);
        }
        if (textParts.length > 0) lines.push(`Assistant: ${textParts.join(" ")}`);
        continue;
      }
      for (const block of blocks(message)) {
        if (!isToolResult(block)) continue;
        const content = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
        lines.push(`Tool Result: ${content}`);
      }
    }
  });
  return lines.join("\n");
};

const summaryMessage = (summary: string, kind: "history" | "midturn"): RuntimeMessage => ({
  role: "user",
  content: kind === "history"
    ? `The conversation history before this point was compacted into the following summary: ${summary.trim()}`
    : `The intermediate steps of the current task were compacted into the following checkpoint summary: ${summary.trim()}`,
});

export function isContextOverflowError(error: unknown): boolean {
  if (object(error).contextOverflow === true || object(error).context_overflow === true) return true;
  const value = String(error instanceof Error ? error.message : error ?? "").toLowerCase();
  return [
    "context overflow", "context window", "maximum context", "context length", "too many tokens",
    "prompt is too long", "input is too long", "overloaded input", "model token limit",
    "exceeded model token limit", "total message size", "exceeds limit",
  ].some((indicator) => value.includes(indicator));
}

export class ContextOverflowError extends Error {
  readonly contextOverflow = true;
  constructor(readonly estimatedTokens: number, readonly hardLimit: number) {
    super(`当前上下文超过模型窗口，已尝试压缩但仍无法安全发送（estimated=${estimatedTokens} limit=${hardLimit}）。请缩短输入或清理较大的工具结果后重试。`);
    this.name = "ContextOverflowError";
  }
}

export class ContextCompactionError extends Error {
  readonly contextCompaction = true;
  constructor(
    readonly reason: "no_safe_prefix" | "summary_failed" | "summary_not_smaller",
    readonly estimatedTokens: number,
  ) {
    const detail = reason === "no_safe_prefix"
      ? "没有找到可安全压缩且保持工具调用闭合的历史前缀"
      : reason === "summary_not_smaller"
        ? "摘要没有降低上下文 token 数"
        : "上下文摘要在两次尝试后仍失败或为空";
    super(`上下文已达到压缩阈值，但无法安全完成压缩：${detail}（estimated=${estimatedTokens}）。原始历史未被删除，请稍后重试。`);
    this.name = "ContextCompactionError";
  }
}

export interface ContextCompactionResult {
  messages: RuntimeMessage[];
  compacted: boolean;
  summaryText: string;
  compactedCount: number;
  beforeTokens: number;
  afterTokens: number;
  apiCalls: number;
  usage: RuntimeUsage;
  hardLimitExceeded: boolean;
  failureReason?: "no_safe_prefix" | "summary_failed" | "summary_not_smaller";
}

export interface ContextPipelineOptions {
  provider: RuntimeProvider;
  store: RuntimeStore;
  contextWindowTokens?: number;
  reserveTokens?: number;
  recentRawTokens?: number;
  toolResultMaxTokens?: number;
  preCallThreshold?: number;
  summaryMaxAttempts?: number;
}

export class ContextPipeline {
  private readonly logger = createLogger("runtime.context");
  private readonly contextWindowTokens: number;
  private readonly reserveTokens: number;
  private readonly recentRawTokens: number;
  readonly toolResultMaxTokens: number;
  readonly hardLimitTokens: number;
  private readonly preCallThreshold: number;
  private readonly summaryMaxAttempts: number;

  constructor(private readonly options: ContextPipelineOptions) {
    this.contextWindowTokens = Math.max(1, Math.trunc(options.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS));
    this.reserveTokens = Math.max(1, Math.trunc(options.reserveTokens ?? DEFAULT_RESERVE_TOKENS));
    this.hardLimitTokens = Math.max(1, this.contextWindowTokens - this.reserveTokens);
    this.recentRawTokens = Math.max(1, Math.trunc(options.recentRawTokens ?? RECENT_RAW_TURN_TOKEN_LIMIT));
    this.toolResultMaxTokens = Math.max(1, Math.trunc(options.toolResultMaxTokens ?? STEP_TOOL_RESULT_MAX_TOKENS));
    this.preCallThreshold = Math.min(1, Math.max(0.1, options.preCallThreshold ?? PRECALL_COMPACTION_USAGE_THRESHOLD));
    this.summaryMaxAttempts = Math.max(1, Math.trunc(options.summaryMaxAttempts ?? SUMMARY_COMPACTION_MAX_ATTEMPTS));
  }

  async prepare(params: {
    sessionId: string;
    messages: RuntimeMessage[];
    systemPrompt: string;
    toolSchemas: ToolSchema[];
    signal: AbortSignal;
    trigger?: "pre_call" | "overflow" | "post_turn";
  }): Promise<ContextCompactionResult> {
    const trigger = params.trigger ?? "pre_call";
    const sanitized = sanitizeMessagesForProvider(params.messages);
    let messages = sanitized.messages;
    if (sanitized.changed) {
      await this.options.store.replaceMessages(params.sessionId, messages, "repair", { reason: `${trigger}_repair` });
    }
    const beforeTokens = requestContextTokenEstimate(params.systemPrompt, messages, params.toolSchemas);
    const hardLimit = this.hardLimitTokens;
    const triggerLimit = trigger === "pre_call"
      ? Math.min(hardLimit, Math.max(1, Math.trunc(this.contextWindowTokens * this.preCallThreshold)))
      : hardLimit;
    if (trigger !== "overflow" && beforeTokens <= triggerLimit) {
      return {
        messages,
        compacted: false,
        summaryText: "",
        compactedCount: 0,
        beforeTokens,
        afterTokens: beforeTokens,
        apiCalls: 0,
        usage: emptyUsage(),
        hardLimitExceeded: false,
      };
    }

    const compacted = await this.compact({ ...params, messages, trigger, beforeTokens, triggerLimit });
    messages = compacted.messages;
    const afterTokens = requestContextTokenEstimate(params.systemPrompt, messages, params.toolSchemas);
    return { ...compacted, afterTokens, hardLimitExceeded: afterTokens > hardLimit };
  }

  async postTurn(params: {
    sessionId: string;
    messages: RuntimeMessage[];
    systemPrompt: string;
    signal: AbortSignal;
  }): Promise<ContextCompactionResult> {
    const pruned = pruneProcessedHistoryImages(params.messages);
    let messages = pruned.messages;
    if (pruned.changed) {
      await this.options.store.replaceMessages(params.sessionId, messages, "context_replacement", {
        reason: "processed_history_images",
      });
    }
    return this.prepare({
      ...params,
      messages,
      toolSchemas: [],
      trigger: "post_turn",
    });
  }

  private async compact(params: {
    sessionId: string;
    messages: RuntimeMessage[];
    systemPrompt: string;
    toolSchemas: ToolSchema[];
    signal: AbortSignal;
    trigger: "pre_call" | "overflow" | "post_turn";
    beforeTokens: number;
    triggerLimit: number;
  }): Promise<ContextCompactionResult> {
    const usage = emptyUsage();
    let apiCalls = 0;
    const recent = selectRecentTurns(params.messages, this.recentRawTokens);
    let kind: "history" | "midturn" = "history";
    let target = recent.compacted;
    let nextMessages: RuntimeMessage[] | undefined;
    let originalUserMessage: RuntimeMessage | undefined;

    if (target.length === 0) {
      const plan = selectMidturnPlan(params.messages, this.recentRawTokens);
      if (!plan) return this.noCompaction(params.messages, params.beforeTokens, usage, apiCalls, "no_safe_prefix");
      kind = "midturn";
      target = plan.compacted;
      originalUserMessage = plan.originalUserMessage;
      const summary = await this.summarize(target, kind, params.signal, usage, originalUserMessage);
      apiCalls += summary.attempts;
      if (!summary.text) return this.noCompaction(params.messages, params.beforeTokens, usage, apiCalls, "summary_failed");
      nextMessages = [...plan.prefix, plan.originalUserMessage, summaryMessage(summary.text, kind), ...plan.retained];
      return this.persistCompaction(params, nextMessages, summary.text, target.length, usage, apiCalls, kind);
    }

    const summary = await this.summarize(target, kind, params.signal, usage);
    apiCalls += summary.attempts;
    if (!summary.text) return this.noCompaction(params.messages, params.beforeTokens, usage, apiCalls, "summary_failed");
    nextMessages = [summaryMessage(summary.text, kind), ...recent.retained];
    let combinedSummaryText = summary.text;
    let totalCompactedCount = target.length;
    let afterTokens = requestContextTokenEstimate(params.systemPrompt, nextMessages, params.toolSchemas);
    if (afterTokens > params.triggerLimit) {
      const midturn = selectMidturnPlan(nextMessages, this.recentRawTokens);
      if (midturn) {
        const midSummary = await this.summarize(
          midturn.compacted,
          "midturn",
          params.signal,
          usage,
          midturn.originalUserMessage,
        );
        apiCalls += midSummary.attempts;
        if (midSummary.text) {
          nextMessages = [
            ...midturn.prefix,
            midturn.originalUserMessage,
            summaryMessage(midSummary.text, "midturn"),
            ...midturn.retained,
          ];
          combinedSummaryText = `${summary.text}\n\n${midSummary.text}`;
          totalCompactedCount += midturn.compacted.length;
          afterTokens = requestContextTokenEstimate(params.systemPrompt, nextMessages, params.toolSchemas);
        }
      }
    }
    return this.persistCompaction(
      params,
      nextMessages,
      combinedSummaryText,
      totalCompactedCount,
      usage,
      apiCalls,
      kind,
    );
  }

  private async summarize(
    messages: RuntimeMessage[],
    kind: "history" | "midturn",
    signal: AbortSignal,
    usage: RuntimeUsage,
    originalUserMessage?: RuntimeMessage,
  ): Promise<{ text: string; attempts: number }> {
    const transcript = renderSummaryTranscript(messages);
    if (!transcript.trim()) return { text: "", attempts: 0 };
    const original = originalUserMessage ? userText(originalUserMessage.content) : "";
    const prompt = kind === "history"
      ? `${HISTORY_SUMMARY_PROMPT}\n\nConversation to summarize:\n${transcript}`
      : `${MIDTURN_SUMMARY_PROMPT}\n\nOriginal user request:\n${original}\n\nIntermediate steps to summarize:\n${transcript}`;
    for (let attempt = 1; attempt <= this.summaryMaxAttempts; attempt += 1) {
      if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
      try {
        const result = await this.options.provider.summarize({
          messages: [{ role: "user", content: prompt }],
          signal,
          kind,
        });
        addUsage(usage, result.usage);
        if (result.text.trim()) return { text: result.text.trim(), attempts: attempt };
        this.logger.warn("context summary returned empty", { kind, attempt, max_attempts: this.summaryMaxAttempts });
      } catch (error) {
        if (signal.aborted || (error instanceof DOMException && error.name === "AbortError")) throw error;
        this.logger.warn("context summary failed", { kind, attempt, max_attempts: this.summaryMaxAttempts, error });
        if (isContextOverflowError(error)) return { text: "", attempts: attempt };
      }
    }
    return { text: "", attempts: this.summaryMaxAttempts };
  }

  private async persistCompaction(
    params: {
      sessionId: string;
      messages: RuntimeMessage[];
      systemPrompt: string;
      toolSchemas: ToolSchema[];
      signal: AbortSignal;
      trigger: "pre_call" | "overflow" | "post_turn";
      beforeTokens: number;
    },
    messages: RuntimeMessage[],
    summaryText: string,
    compactedCount: number,
    usage: RuntimeUsage,
    apiCalls: number,
    kind: "history" | "midturn",
  ): Promise<ContextCompactionResult> {
    const sanitized = sanitizeMessagesForProvider(messages).messages;
    const afterTokens = requestContextTokenEstimate(params.systemPrompt, sanitized, params.toolSchemas);
    if (afterTokens >= params.beforeTokens) {
      this.logger.warn("context summary did not reduce tokens", {
        trigger: params.trigger,
        before_tokens: params.beforeTokens,
        after_tokens: afterTokens,
      });
      return this.noCompaction(params.messages, params.beforeTokens, usage, apiCalls, "summary_not_smaller");
    }
    if (params.signal.aborted) throw params.signal.reason ?? new DOMException("Aborted", "AbortError");
    await this.options.store.replaceMessages(params.sessionId, sanitized, "compaction", {
      reason: `${params.trigger}_compaction`,
      trigger: params.trigger,
      summary_kind: kind,
      summary_text: summaryText,
      compacted_count: compactedCount,
      before_tokens: params.beforeTokens,
      after_tokens: afterTokens,
    });
    this.logger.info("context compacted", {
      session_id: params.sessionId,
      trigger: params.trigger,
      kind,
      compacted_count: compactedCount,
      before_tokens: params.beforeTokens,
      after_tokens: afterTokens,
    });
    return {
      messages: sanitized,
      compacted: true,
      summaryText,
      compactedCount,
      beforeTokens: params.beforeTokens,
      afterTokens,
      apiCalls,
      usage,
      hardLimitExceeded: false,
    };
  }

  private noCompaction(
    messages: RuntimeMessage[],
    tokens: number,
    usage: RuntimeUsage,
    apiCalls: number,
    failureReason?: ContextCompactionResult["failureReason"],
  ): ContextCompactionResult {
    return {
      messages,
      compacted: false,
      summaryText: "",
      compactedCount: 0,
      beforeTokens: tokens,
      afterTokens: tokens,
      apiCalls,
      usage,
      hardLimitExceeded: false,
      ...(failureReason === undefined ? {} : { failureReason }),
    };
  }
}
