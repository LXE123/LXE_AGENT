import type { RuntimeStreamEvent } from "../../engine/types";

type ContentKind = "text" | "thinking";

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

const text = (value: unknown): string => String(value ?? "");

const requiredId = (value: unknown, eventType: string): string => {
  const result = text(value).trim();
  if (!result) throw new Error(`${eventType} requires item_id`);
  return result;
};

/** Maps OpenAI Responses events onto the runtime's model-output vocabulary. */
export class OpenAIResponsesStreamAdapter {
  private readonly contentKinds = new Map<string, ContentKind>();
  private readonly completedContentParts = new Set<string>();
  private readonly toolParts = new Set<string>();
  private readonly completedToolParts = new Set<string>();

  constructor(private readonly emit: (event: RuntimeStreamEvent) => void) {}

  streamEvent(value: unknown): void {
    const event = record(value);
    const type = text(event.type);
    if (type === "response.output_text.delta") {
      this.delta("text", event.item_id, event.content_index, text(event.delta));
      return;
    }
    if (type === "response.output_text.done") {
      this.done("text", event.item_id, event.content_index, text(event.text));
      return;
    }
    if (type === "response.reasoning_text.delta") {
      this.delta("thinking", event.item_id, event.content_index, text(event.delta));
      return;
    }
    if (type === "response.reasoning_text.done") {
      this.done("thinking", event.item_id, event.content_index, text(event.text));
      return;
    }
    // OpenRouter's Responses stream currently uses the shorter reasoning
    // event names and omits content_index because each reasoning item is one
    // logical part. Keep accepting OpenAI's reasoning_text variant above.
    if (type === "response.reasoning.delta") {
      this.delta("thinking", event.item_id, event.content_index ?? 0, text(event.delta));
      return;
    }
    if (type === "response.reasoning.done") {
      this.done("thinking", event.item_id, event.content_index ?? 0, text(event.text ?? event.reasoning));
      return;
    }
    if (type === "response.output_item.added") {
      const item = record(event.item);
      if (item.type === "function_call") this.openTool(item);
      return;
    }
    if (type === "response.function_call_arguments.delta") {
      this.toolDelta(event.item_id, text(event.delta));
      return;
    }
    if (type === "response.function_call_arguments.done") {
      this.endTool(event.item_id);
      return;
    }
    if (type === "response.output_item.done") {
      const item = record(event.item);
      if (item.type !== "function_call") return;
      this.openTool(item);
      this.endTool(item.id);
    }
  }

  delta(kind: ContentKind, itemId: unknown, contentIndex: unknown, value: string): void {
    if (!value) return;
    const partId = this.contentPartId(itemId, contentIndex);
    if (this.completedContentParts.has(partId)) throw new Error(`Responses delta arrived after completion for ${partId}`);
    this.openContent(partId, kind);
    this.emit(kind === "text"
      ? { type: "text_delta", part_id: partId, text: value }
      : { type: "thinking_delta", part_id: partId, thinking: value });
  }

  done(kind: ContentKind, itemId: unknown, contentIndex: unknown, full = ""): void {
    const partId = this.contentPartId(itemId, contentIndex);
    if (this.completedContentParts.has(partId)) return;
    if (!this.contentKinds.has(partId)) {
      this.openContent(partId, kind);
      if (full) this.delta(kind, itemId, contentIndex, full);
    }
    this.emit(kind === "text" ? { type: "text_end", part_id: partId } : { type: "thinking_end", part_id: partId });
    this.contentKinds.delete(partId);
    this.completedContentParts.add(partId);
  }

  finish(): void {
    for (const [partId, kind] of [...this.contentKinds]) {
      this.emit(kind === "text" ? { type: "text_end", part_id: partId } : { type: "thinking_end", part_id: partId });
      this.contentKinds.delete(partId);
      this.completedContentParts.add(partId);
    }
    for (const partId of [...this.toolParts]) this.endTool(partId);
  }

  private contentPartId(itemId: unknown, contentIndex: unknown): string {
    const index = typeof contentIndex === "number" ? Math.trunc(contentIndex) : Number.NaN;
    if (!Number.isSafeInteger(index) || index < 0) throw new Error("Responses content event requires content_index");
    return `${requiredId(itemId, "Responses content event")}#${index}`;
  }

  private openContent(partId: string, kind: ContentKind): void {
    const existing = this.contentKinds.get(partId);
    if (existing === kind) return;
    if (existing) throw new Error(`Responses part ${partId} changed kind from ${existing} to ${kind}`);
    this.contentKinds.set(partId, kind);
    this.emit(kind === "text" ? { type: "text_start", part_id: partId } : { type: "thinking_start", part_id: partId });
  }

  private openTool(item: Record<string, unknown>): void {
    const partId = requiredId(item.id, "response.output_item function_call");
    if (this.toolParts.has(partId) || this.completedToolParts.has(partId)) return;
    const toolCallId = text(item.call_id).trim();
    const name = text(item.name).trim();
    if (!toolCallId || !name) throw new Error("Responses function_call requires call_id and name");
    this.toolParts.add(partId);
    this.emit({ type: "tool_input_start", part_id: partId, tool_call_id: toolCallId, name });
  }

  private toolDelta(itemId: unknown, fragment: string): void {
    if (!fragment) return;
    const partId = requiredId(itemId, "response.function_call_arguments.delta");
    if (!this.toolParts.has(partId)) {
      throw new Error(`Responses function call delta arrived before output_item.added for ${partId}`);
    }
    this.emit({ type: "tool_input_delta", part_id: partId, delta: fragment });
  }

  private endTool(itemId: unknown): void {
    const partId = requiredId(itemId, "Responses function call completion");
    if (this.completedToolParts.has(partId)) return;
    if (!this.toolParts.has(partId)) {
      throw new Error(`Responses function call completion arrived before output_item.added for ${partId}`);
    }
    this.toolParts.delete(partId);
    this.completedToolParts.add(partId);
    this.emit({ type: "tool_input_end", part_id: partId });
  }
}

// Preserve the existing internal export while callers migrate to the protocol-specific name.
export { OpenAIResponsesStreamAdapter as ResponsesStreamNormalizer };
