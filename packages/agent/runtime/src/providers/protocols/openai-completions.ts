import type { JsonObject } from "@lxe/protocol";
import type {
  RuntimeContentBlock,
  RuntimeStreamEvent,
  RuntimeTurnResponse,
  RuntimeUsage,
} from "../../engine/types";

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

const text = (value: unknown): string => String(value ?? "");

const parsedArguments = (value: string): JsonObject => {
  if (!value.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as JsonObject;
  } catch { /* Preserve the model's exact invalid output below. */ }
  return { __unparsed_arguments: value };
};

const completionUsage = (value: unknown): RuntimeUsage => {
  const usage = record(value);
  const details = record(usage.prompt_tokens_details);
  const inclusiveInput = Math.max(0, Math.trunc(Number(usage.prompt_tokens) || 0));
  const cacheRead = Math.max(0, Math.trunc(Number(details.cached_tokens) || 0));
  return {
    input_tokens: Math.max(0, inclusiveInput - cacheRead),
    output_tokens: Math.max(0, Math.trunc(Number(usage.completion_tokens) || 0)),
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: 0,
  };
};

type ActiveContent = {
  kind: "text" | "thinking";
  partId: string;
  sourceField: string;
  block: Record<string, unknown>;
};

type ToolState = {
  index: number;
  partId: string;
  id: string;
  name: string;
  arguments: string;
  emittedArguments: number;
  started: boolean;
  ended: boolean;
  block: Record<string, unknown>;
};

const stopReason = (raw: string): string => {
  if (raw === "stop" || raw === "end") return "end_turn";
  if (raw === "tool_calls" || raw === "function_call") return "tool_use";
  if (raw === "length") return "length";
  throw new Error(`Provider finish_reason: ${raw || "missing"}`);
};

/** Maps streamed Chat Completions chunks onto the runtime's event and block vocabulary. */
export class OpenAICompletionsStreamAdapter {
  private readonly blocks: RuntimeContentBlock[] = [];
  private readonly tools = new Map<number, ToolState>();
  private activeContent: ActiveContent | undefined;
  private contentSequence = 0;
  private rawFinishReason = "";
  private sawFinishReason = false;
  private usage: RuntimeUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };

  constructor(private readonly emit: (event: RuntimeStreamEvent) => void) {}

  streamEvent(value: unknown): void {
    const chunk = record(value);
    if (chunk.error) throw new Error(JSON.stringify(chunk.error));
    if (chunk.usage) this.usage = completionUsage(chunk.usage);
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    const choice = record(choices[0]);
    if (choices.length === 0) {
      return;
    }
    const delta = record(choice.delta);
    const reasoningField = ["reasoning_content", "reasoning", "reasoning_text"]
      .find((field) => typeof delta[field] === "string" && text(delta[field]).length > 0);
    if (reasoningField) this.contentDelta("thinking", text(delta[reasoningField]), reasoningField);
    if (typeof delta.content === "string" && delta.content.length > 0) {
      this.contentDelta("text", delta.content, "content");
    }
    if (Array.isArray(delta.tool_calls)) {
      this.closeContent();
      for (const raw of delta.tool_calls) this.toolDelta(record(raw));
    }
    if (choice.finish_reason !== null && choice.finish_reason !== undefined && text(choice.finish_reason)) {
      this.rawFinishReason = text(choice.finish_reason);
      this.sawFinishReason = true;
      this.closeContent();
      this.closeTools();
    }
  }

  finish(): void {
    this.closeContent();
    this.closeTools();
  }

  result(): RuntimeTurnResponse {
    if (!this.sawFinishReason) throw new Error("Chat Completions stream ended without finish_reason");
    return {
      content: this.blocks,
      stop_reason: stopReason(this.rawFinishReason),
      usage: this.usage,
    };
  }

  private contentDelta(kind: "text" | "thinking", fragment: string, sourceField: string): void {
    if (!fragment) return;
    if (this.activeContent?.kind !== kind || this.activeContent.sourceField !== sourceField) {
      this.closeContent();
      const partId = `chat_content_${this.contentSequence++}`;
      const block: Record<string, unknown> = kind === "text"
        ? { type: "text", text: "" }
        : { type: "thinking", thinking: "", signature: sourceField };
      this.blocks.push(block as RuntimeContentBlock);
      this.activeContent = { kind, partId, sourceField, block };
      this.emit(kind === "text"
        ? { type: "text_start", part_id: partId }
        : { type: "thinking_start", part_id: partId });
    }
    const active = this.activeContent!;
    if (kind === "text") {
      active.block.text = text(active.block.text) + fragment;
      this.emit({ type: "text_delta", part_id: active.partId, text: fragment });
    } else {
      active.block.thinking = text(active.block.thinking) + fragment;
      this.emit({ type: "thinking_delta", part_id: active.partId, thinking: fragment });
    }
  }

  private closeContent(): void {
    const active = this.activeContent;
    if (!active) return;
    this.emit(active.kind === "text"
      ? { type: "text_end", part_id: active.partId }
      : { type: "thinking_end", part_id: active.partId });
    this.activeContent = undefined;
  }

  private toolDelta(delta: Record<string, unknown>): void {
    const index = Number(delta.index);
    if (!Number.isSafeInteger(index) || index < 0) throw new Error("Chat Completions tool delta requires index");
    let tool = this.tools.get(index);
    if (!tool) {
      const block: Record<string, unknown> = { type: "tool_call", id: "", name: "", arguments: {} };
      tool = {
        index,
        partId: `chat_tool_${index}`,
        id: "",
        name: "",
        arguments: "",
        emittedArguments: 0,
        started: false,
        ended: false,
        block,
      };
      this.tools.set(index, tool);
      this.blocks.push(block as RuntimeContentBlock);
    }
    const fn = record(delta.function);
    if (typeof delta.id === "string" && delta.id) tool.id += delta.id;
    if (typeof fn.name === "string" && fn.name) tool.name += fn.name;
    if (typeof fn.arguments === "string" && fn.arguments.length > 0) tool.arguments += fn.arguments;
    tool.block.id = tool.id;
    tool.block.name = tool.name;
    tool.block.arguments = parsedArguments(tool.arguments);
    if (tool.arguments.length > 0) this.startTool(tool);
    if (tool.started && tool.arguments.length > tool.emittedArguments) {
      const fragment = tool.arguments.slice(tool.emittedArguments);
      tool.emittedArguments = tool.arguments.length;
      this.emit({ type: "tool_input_delta", part_id: tool.partId, delta: fragment });
    }
  }

  private startTool(tool: ToolState): void {
    if (tool.started || !tool.id || !tool.name) return;
    tool.started = true;
    this.emit({
      type: "tool_input_start",
      part_id: tool.partId,
      tool_call_id: tool.id,
      name: tool.name,
    });
  }

  private closeTools(): void {
    for (const tool of this.tools.values()) {
      if (tool.ended) continue;
      this.startTool(tool);
      if (!tool.started) {
        throw new Error(`Chat Completions tool call ${tool.index} ended without id or name`);
      }
      if (tool.arguments.length > tool.emittedArguments) {
        const fragment = tool.arguments.slice(tool.emittedArguments);
        tool.emittedArguments = tool.arguments.length;
        this.emit({ type: "tool_input_delta", part_id: tool.partId, delta: fragment });
      }
      tool.block.arguments = parsedArguments(tool.arguments);
      tool.ended = true;
      this.emit({ type: "tool_input_end", part_id: tool.partId });
    }
  }
}
