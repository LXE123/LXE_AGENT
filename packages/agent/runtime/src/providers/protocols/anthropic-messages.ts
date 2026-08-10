import { randomUUID } from "node:crypto";
import type { RuntimeStreamEvent } from "../../engine/types";

type AnthropicBlock =
  | { type: "text"; partId: string }
  | { type: "thinking"; partId: string }
  | { type: "tool_input"; partId: string };

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

const blockIndex = (value: unknown): number => {
  const index = typeof value === "number" ? Math.trunc(value) : Number.NaN;
  if (!Number.isSafeInteger(index) || index < 0) throw new Error("Anthropic stream event requires a valid block index");
  return index;
};

const requiredText = (value: unknown, field: string): string => {
  const result = String(value ?? "").trim();
  if (!result) throw new Error(`Anthropic tool_use requires ${field}`);
  return result;
};

/** Maps Anthropic Messages block events onto the runtime's model-output vocabulary. */
export class AnthropicMessagesStreamAdapter {
  private readonly blocks = new Map<number, AnthropicBlock>();
  private readonly completedPartIds = new Set<string>();
  private activeBlockIndex: number | undefined;

  constructor(
    private readonly emit: (event: RuntimeStreamEvent) => void,
    private readonly createPartId: () => string = () => randomUUID(),
  ) {}

  streamEvent(value: unknown): void {
    const event = record(value);
    if (event.type === "content_block_start") {
      this.startBlock(blockIndex(event.index), record(event.content_block));
      return;
    }
    if (event.type === "content_block_delta") {
      this.deltaBlock(blockIndex(event.index), record(event.delta));
      return;
    }
    if (event.type === "content_block_stop") this.stopBlock(blockIndex(event.index));
  }

  finish(): void {
    for (const [index, block] of [...this.blocks]) {
      this.blocks.delete(index);
      this.endPart(block);
    }
    this.activeBlockIndex = undefined;
  }

  private startBlock(index: number, block: Record<string, unknown>): void {
    if (this.activeBlockIndex !== undefined && this.activeBlockIndex !== index) {
      this.stopBlock(this.activeBlockIndex);
    }
    const existing = this.blocks.get(index);
    if (existing) this.endPart(existing);
    this.blocks.delete(index);
    this.activeBlockIndex = undefined;

    if (block.type === "redacted_thinking") {
      this.emit({ type: "redacted_thinking", part_id: this.createPartId() });
      return;
    }

    if (block.type === "text") {
      const partId = this.createPartId();
      this.blocks.set(index, { type: "text", partId });
      this.activeBlockIndex = index;
      this.emit({ type: "text_start", part_id: partId });
      const text = String(block.text ?? "");
      if (text) this.emit({ type: "text_delta", part_id: partId, text });
      return;
    }

    if (block.type === "thinking") {
      const partId = this.createPartId();
      this.blocks.set(index, { type: "thinking", partId });
      this.activeBlockIndex = index;
      this.emit({ type: "thinking_start", part_id: partId });
      const thinking = String(block.thinking ?? "");
      if (thinking) this.emit({ type: "thinking_delta", part_id: partId, thinking });
      return;
    }

    if (block.type === "tool_use") {
      const toolCallId = requiredText(block.id, "id");
      const name = requiredText(block.name, "name");
      this.blocks.set(index, { type: "tool_input", partId: toolCallId });
      this.activeBlockIndex = index;
      this.emit({
        type: "tool_input_start",
        part_id: toolCallId,
        tool_call_id: toolCallId,
        name,
      });
    }
  }

  private deltaBlock(index: number, delta: Record<string, unknown>): void {
    if (delta.type !== "text_delta" && delta.type !== "thinking_delta" && delta.type !== "input_json_delta") return;
    const block = this.blocks.get(index);
    if (!block) throw new Error(`Anthropic ${String(delta.type)} arrived before content_block_start for index ${index}`);

    if (delta.type === "text_delta") {
      if (block.type !== "text") throw new Error(`Anthropic text_delta does not match block ${index}`);
      const text = String(delta.text ?? "");
      if (text) this.emit({ type: "text_delta", part_id: block.partId, text });
      return;
    }

    if (delta.type === "thinking_delta") {
      if (block.type !== "thinking") throw new Error(`Anthropic thinking_delta does not match block ${index}`);
      const thinking = String(delta.thinking ?? "");
      if (thinking) this.emit({ type: "thinking_delta", part_id: block.partId, thinking });
      return;
    }

    if (block.type !== "tool_input") throw new Error(`Anthropic input_json_delta does not match block ${index}`);
    const fragment = String(delta.partial_json ?? "");
    if (fragment) this.emit({ type: "tool_input_delta", part_id: block.partId, delta: fragment });
  }

  private stopBlock(index: number): void {
    const block = this.blocks.get(index);
    if (!block) return;
    this.blocks.delete(index);
    if (this.activeBlockIndex === index) this.activeBlockIndex = undefined;
    this.endPart(block);
  }

  private endPart(block: AnthropicBlock): void {
    if (this.completedPartIds.has(block.partId)) return;
    this.completedPartIds.add(block.partId);
    if (block.type === "text") this.emit({ type: "text_end", part_id: block.partId });
    else if (block.type === "thinking") this.emit({ type: "thinking_end", part_id: block.partId });
    else this.emit({ type: "tool_input_end", part_id: block.partId });
  }
}

// Preserve the existing internal export while callers migrate to the protocol-specific name.
export { AnthropicMessagesStreamAdapter as ProviderStreamNormalizer };
