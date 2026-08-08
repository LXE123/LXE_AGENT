import OpenAI from "openai";
import type { JsonObject } from "@lxe/protocol";
import type {
  RuntimeContentBlock,
  RuntimeMessage,
  RuntimeProvider,
  RuntimeProviderRequest,
  RuntimeStreamEvent,
  RuntimeSummaryRequest,
  RuntimeSummaryResult,
  RuntimeTurnResponse,
  RuntimeUsage,
  ToolSchema,
} from "../engine/types";
import {
  normalizeProviderError,
  normalizeThinkingEffort,
  ProviderIdleWatchdog,
  RuntimeProviderError,
  SUMMARY_SYSTEM_PROMPT,
  type ProviderDescriptor,
} from "./provider";

const IMAGE_PLACEHOLDER = "[image omitted: DeepSeek Responses API does not support image content]";

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

const text = (value: unknown): string => String(value ?? "");

const inputText = (content: RuntimeMessage["content"]): string => {
  if (!Array.isArray(content)) return text(content);
  const parts: string[] = [];
  for (const raw of content) {
    const block = record(raw);
    if (block.type === "text") parts.push(text(block.text));
    else if (block.type === "image") parts.push(IMAGE_PLACEHOLDER);
  }
  return parts.join("\n").trim();
};

const toolResultText = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content === undefined ? "" : JSON.stringify(content);
  return content
    .map((raw) => {
      const block = record(raw);
      return block.type === "text" ? text(block.text) : JSON.stringify(raw);
    })
    .join("\n");
};

/**
 * Responses carries assistant tool calls and their outputs as sibling top-level
 * items rather than as content blocks inside a message, so one RuntimeMessage
 * can expand into several input items.
 */
export function adaptMessagesForResponses(messages: RuntimeMessage[]): JsonObject[] {
  const input: JsonObject[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      input.push({
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: inputText(message.content) }],
      });
      continue;
    }
    if (message.role === "system") {
      input.push({
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: `[System Message]\n${text(message.content)}` }],
      });
      continue;
    }
    if (message.role === "assistant") {
      const source = Array.isArray(message.content)
        ? message.content
        : [{ type: "text", text: text(message.content) }];
      const spoken: string[] = [];
      const calls: JsonObject[] = [];
      for (const raw of source) {
        const block = record(raw);
        // Reasoning content cannot be replayed: DeepSeek accepts summaries but
        // never generates them, so there is nothing faithful to send back.
        if (block.type === "text") spoken.push(text(block.text));
        else if (block.type === "tool_call") {
          calls.push({
            type: "function_call",
            call_id: text(block.id),
            name: text(block.name),
            arguments: JSON.stringify(record(block.arguments)),
          });
        }
      }
      const joined = spoken.join("\n").trim();
      if (joined) {
        input.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: joined }],
        });
      }
      input.push(...calls);
      continue;
    }
    for (const raw of Array.isArray(message.content) ? message.content : []) {
      const block = record(raw);
      if (block.type !== "tool_result") continue;
      input.push({
        type: "function_call_output",
        call_id: text(block.tool_call_id),
        output: toolResultText(block.content),
      });
    }
  }
  return input;
}

export const adaptToolsForResponses = (tools: ToolSchema[]): JsonObject[] => tools.map((tool) => ({
  type: "function",
  name: tool.name,
  description: tool.description,
  parameters: tool.input_schema,
}));

/**
 * Responses spells thinking differently from the Anthropic-compatible wire:
 * `reasoning.effort` over none/low/high/max, where "none" is what switches it
 * off. The other wire's `thinking` + `output_config` pair means nothing here,
 * and DeepSeek ignores parameters it does not recognise instead of rejecting
 * them - so the wrong shape leaves reasoning running at its default rather than
 * failing where anyone would notice.
 */
export const buildResponsesThinkingPayload = (descriptor: ProviderDescriptor): Record<string, unknown> => {
  if (descriptor.thinkingStyle === "provider-managed") return {};
  if (!descriptor.thinkingEnabled || descriptor.thinkingEffort === "off") {
    return { reasoning: { effort: "none" } };
  }
  return {
    reasoning: {
      effort: normalizeThinkingEffort(
        descriptor.thinkingEffort,
        descriptor.thinkingLevels.filter((level) => level !== "off"),
        descriptor.thinkingDefault,
      ),
    },
  };
};

/** Summaries take the cheapest setting the model allows. */
export const buildResponsesSummaryThinkingPayload = (
  descriptor: ProviderDescriptor,
): Record<string, unknown> => {
  if (descriptor.thinkingStyle === "provider-managed") return {};
  if (descriptor.thinkingLevels.length > 0 && !descriptor.thinkingLevels.includes("off")) {
    return buildResponsesThinkingPayload({
      ...descriptor,
      thinkingEnabled: true,
      thinkingEffort: descriptor.thinkingDefault,
    });
  }
  return { reasoning: { effort: "none" } };
};

export function buildResponsesRequest(
  descriptor: ProviderDescriptor,
  request: Pick<RuntimeProviderRequest, "system" | "messages" | "tools" | "toolChoice">,
): Record<string, unknown> {
  return {
    model: descriptor.model,
    instructions: request.system.trim(),
    input: adaptMessagesForResponses(request.messages),
    max_output_tokens: descriptor.maxTokens,
    stream: true,
    ...(request.tools.length > 0
      ? { tools: adaptToolsForResponses(request.tools), tool_choice: request.toolChoice }
      : {}),
    ...buildResponsesThinkingPayload(descriptor),
  };
}

/**
 * Turns Responses stream events into the runtime's own event vocabulary. Part
 * identity comes from the provider's own `item_id` plus `content_index`, so it
 * stays stable across the deltas that belong to one block.
 */
export class ResponsesStreamNormalizer {
  private readonly started = new Set<string>();
  private readonly kinds = new Map<string, "text" | "thinking">();

  constructor(private readonly emit: (event: RuntimeStreamEvent) => void) {}

  private partId(itemId: unknown, contentIndex: unknown): string {
    return `${text(itemId) || "item"}#${Math.trunc(Number(contentIndex) || 0)}`;
  }

  private open(partId: string, kind: "text" | "thinking"): void {
    if (this.started.has(partId)) return;
    this.started.add(partId);
    this.kinds.set(partId, kind);
    this.emit(kind === "text" ? { type: "text_start", part_id: partId } : { type: "thinking_start", part_id: partId });
  }

  delta(kind: "text" | "thinking", itemId: unknown, contentIndex: unknown, value: string): void {
    if (!value) return;
    const partId = this.partId(itemId, contentIndex);
    this.open(partId, kind);
    this.emit(kind === "text"
      ? { type: "text_delta", part_id: partId, text: value }
      : { type: "thinking_delta", part_id: partId, thinking: value });
  }

  done(kind: "text" | "thinking", itemId: unknown, contentIndex: unknown, full?: string): void {
    const partId = this.partId(itemId, contentIndex);
    // A block whose entire body arrived in the terminal event still has to be
    // opened and filled, or the reader would see the part appear empty.
    if (!this.started.has(partId)) {
      this.open(partId, kind);
      if (full) this.delta(kind, itemId, contentIndex, full);
    }
    this.emit(kind === "text" ? { type: "text_end", part_id: partId } : { type: "thinking_end", part_id: partId });
    this.started.delete(partId);
    this.kinds.delete(partId);
  }

  finish(): void {
    for (const [partId, kind] of [...this.kinds]) {
      this.emit(kind === "text" ? { type: "text_end", part_id: partId } : { type: "thinking_end", part_id: partId });
      this.started.delete(partId);
      this.kinds.delete(partId);
    }
  }
}

const responsesUsage = (usage: unknown): RuntimeUsage => {
  const value = record(usage);
  const inputDetails = record(value.input_tokens_details);
  return {
    input_tokens: Math.max(0, Math.trunc(Number(value.input_tokens) || 0)),
    output_tokens: Math.max(0, Math.trunc(Number(value.output_tokens) || 0)),
    cache_read_input_tokens: Math.max(0, Math.trunc(Number(inputDetails.cached_tokens) || 0)),
    cache_creation_input_tokens: 0,
  };
};

/** Maps the terminal Responses payload back onto the runtime's block model. */
export function responsesContent(output: unknown): RuntimeContentBlock[] {
  const blocks: RuntimeContentBlock[] = [];
  for (const raw of Array.isArray(output) ? output : []) {
    const item = record(raw);
    if (item.type === "function_call") {
      let parsed: JsonObject = {};
      const serialized = text(item.arguments);
      if (serialized) {
        try {
          parsed = record(JSON.parse(serialized)) as JsonObject;
        } catch {
          // The raw string is what the model produced; keeping it under a known
          // key beats dropping the call or inventing arguments it never sent.
          parsed = { __unparsed_arguments: serialized };
        }
      }
      blocks.push({ type: "tool_call", id: text(item.call_id), name: text(item.name), arguments: parsed });
      continue;
    }
    if (item.type === "reasoning") {
      const thinking = (Array.isArray(item.content) ? item.content : [])
        .map((entry) => record(entry))
        .filter((entry) => entry.type === "reasoning_text")
        .map((entry) => text(entry.text))
        .join("");
      if (thinking) blocks.push({ type: "thinking", thinking });
      continue;
    }
    if (item.type !== "message") continue;
    for (const entry of Array.isArray(item.content) ? item.content : []) {
      const part = record(entry);
      if (part.type === "output_text") blocks.push({ type: "text", text: text(part.text) });
    }
  }
  return blocks;
}

const responsesStopReason = (response: Record<string, unknown>): string => {
  const status = text(response.status);
  if (status === "incomplete") return text(record(response.incomplete_details).reason) || "incomplete";
  if (status === "failed") return "failed";
  const calls = (Array.isArray(response.output) ? response.output : [])
    .some((item) => record(item).type === "function_call");
  return calls ? "tool_use" : "end_turn";
};

export interface ResponsesClientPort {
  responses: {
    stream(body: Record<string, unknown>, options?: { signal?: AbortSignal }): {
      on?(event: string, listener: (payload: unknown) => void): unknown;
      finalResponse(): Promise<unknown>;
    };
  };
}

export class ResponsesRuntimeProvider implements RuntimeProvider {
  private readonly client: ResponsesClientPort;

  constructor(
    private readonly descriptor: ProviderDescriptor,
    client?: ResponsesClientPort,
  ) {
    this.client = client ?? new OpenAI({
      apiKey: descriptor.apiKey,
      baseURL: descriptor.baseURL,
      defaultHeaders: descriptor.defaultHeaders,
    }) as unknown as ResponsesClientPort;
  }

  async turn(request: RuntimeProviderRequest): Promise<RuntimeTurnResponse> {
    const watchdog = new ProviderIdleWatchdog(request.signal, this.descriptor.requestIdleTimeoutMs);
    let wireOk = false;
    let wireError = "";
    const wire = (operation: () => void): void => {
      try { operation(); } catch { /* Diagnostics must not affect Provider execution. */ }
    };
    try {
      const parameters = buildResponsesRequest(this.descriptor, request);
      wire(() => request.wireTrace?.requestStart({
        ...this.descriptor.defaultHeaders,
        "content-type": "application/json",
        authorization: `Bearer ${this.descriptor.apiKey}`,
      }, parameters as unknown as JsonObject));
      let delivery = Promise.resolve();
      const deliver = (event: RuntimeStreamEvent): void => {
        if (!request.onEvent) return;
        delivery = delivery.then(() => request.onEvent?.(event)).then(() => undefined);
      };
      const normalizer = new ResponsesStreamNormalizer(deliver);
      const stream = this.client.responses.stream(parameters, { signal: watchdog.signal });
      // Every frame is traced from one catch-all listener, so the diagnostics
      // keep the events this adapter does not map - lifecycle and failure
      // frames included - instead of only the four it reads.
      wire(() => {
        stream.on?.("event", (payload) => {
          watchdog.activity();
          wire(() => request.wireTrace?.event(text(record(payload).type) || "event", payload));
        });
      });
      const observe = (name: string, handler: (payload: Record<string, unknown>) => void): void => {
        wire(() => {
          stream.on?.(name, (payload) => {
            watchdog.activity();
            try {
              handler(record(payload));
            } catch (error) {
              wire(() => request.wireTrace?.parseError(name, JSON.stringify(payload ?? null), error));
            }
          });
        });
      };
      observe("response.output_text.delta", (event) =>
        normalizer.delta("text", event.item_id, event.content_index, text(event.delta)));
      observe("response.output_text.done", (event) =>
        normalizer.done("text", event.item_id, event.content_index, text(event.text)));
      observe("response.reasoning_text.delta", (event) =>
        normalizer.delta("thinking", event.item_id, event.content_index, text(event.delta)));
      observe("response.reasoning_text.done", (event) =>
        normalizer.done("thinking", event.item_id, event.content_index, text(event.text)));
      const response = record(await stream.finalResponse());
      normalizer.finish();
      await delivery;
      wireOk = true;
      return {
        content: responsesContent(response.output),
        stop_reason: responsesStopReason(response),
        usage: responsesUsage(response.usage),
      };
    } catch (error) {
      wireError = String(error instanceof Error ? error.message : error);
      if (request.signal.aborted) throw request.signal.reason ?? new DOMException("Aborted", "AbortError");
      if (watchdog.timedOut()) {
        throw new RuntimeProviderError(
          `provider request idle timed out after ${this.descriptor.requestIdleTimeoutMs}ms`,
          this.descriptor.name,
          "请求超时",
          `${this.descriptor.name} 请求超时，请稍后重试。`,
          true,
        );
      }
      throw normalizeProviderError(error, this.descriptor);
    } finally {
      wire(() => request.wireTrace?.end(wireOk, wireError));
      watchdog.cleanup();
    }
  }

  async summarize(request: RuntimeSummaryRequest): Promise<RuntimeSummaryResult> {
    const watchdog = new ProviderIdleWatchdog(request.signal, this.descriptor.requestIdleTimeoutMs);
    try {
      const stream = this.client.responses.stream({
        model: this.descriptor.model,
        instructions: SUMMARY_SYSTEM_PROMPT,
        input: adaptMessagesForResponses(request.messages),
        max_output_tokens: Math.min(32_768, this.descriptor.maxTokens),
        stream: true,
        ...buildResponsesSummaryThinkingPayload(this.descriptor),
      }, { signal: watchdog.signal });
      try {
        stream.on?.("response.output_text.delta", () => watchdog.activity());
        stream.on?.("response.reasoning_text.delta", () => watchdog.activity());
        stream.on?.("response.output_item.done", () => watchdog.activity());
      } catch { /* Diagnostics/activity hooks must not replace Provider behavior. */ }
      const response = record(await stream.finalResponse());
      const summary = responsesContent(response.output)
        .filter((block) => record(block).type === "text")
        .map((block) => text(record(block).text))
        .join("")
        .trim();
      return { text: summary, usage: responsesUsage(response.usage) };
    } catch (error) {
      if (request.signal.aborted) throw request.signal.reason ?? new DOMException("Aborted", "AbortError");
      if (watchdog.timedOut()) {
        throw new RuntimeProviderError(
          `provider request idle timed out after ${this.descriptor.requestIdleTimeoutMs}ms`,
          this.descriptor.name,
          "请求超时",
          `${this.descriptor.name} 请求超时，请稍后重试。`,
          true,
        );
      }
      throw normalizeProviderError(error, this.descriptor);
    } finally {
      watchdog.cleanup();
    }
  }
}
