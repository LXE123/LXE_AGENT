import { describe, expect, test } from "bun:test";
import type {
  DesktopConversationActivityPayload,
  DesktopConversationStreamBatch,
} from "@lxe/desktop-protocol";
import { applyDesktopStreamBatch } from "../../../src/features/sessions/live-stream";

const metrics = {
  status: "running" as const,
  phase: "thinking" as const,
  elapsed_ms: 16,
  model: "model",
  input_tokens: 0,
  output_tokens: 1,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  context_tokens: 0,
  context_window_tokens: 100,
};

const activity = (): DesktopConversationActivityPayload => ({
  session_id: "session-1",
  active: {
    turn_id: "turn-1",
    message_id: "message-1",
    text: "hello",
    state: "running",
    started_at: 1,
    user_persisted_at: 1,
    settled_at: 0,
    stream: {
      seq: 1,
      state: "delta",
      content: "",
      thinking: "a",
      redacted_thinking_count: 0,
      thinking_elapsed_ms: 0,
      tool_pending: false,
      tool_elapsed_ms: 0,
      tool_steps: [{
        id: "tool-1",
        name: "read",
        title: "Read",
        detail: "notes.txt",
        icon_token: "file",
        status: "running",
        duration_ms: 0,
      }],
      process_parts: [{
        type: "thinking",
        part_id: "thinking-1",
        sequence: 1,
        status: "streaming",
        text: "a",
        redacted_count: 0,
      }, {
        type: "tool",
        part_id: "tool-part-1",
        sequence: 2,
        tool_step: {
          id: "tool-1",
          name: "read",
          title: "Read",
          detail: "notes.txt",
          icon_token: "file",
          status: "running",
          duration_ms: 0,
        },
      }],
      display_metrics: metrics,
    },
  },
  queued: [],
  latest: null,
});

const batch = (patch: Partial<DesktopConversationStreamBatch> = {}): DesktopConversationStreamBatch => ({
  session_id: "session-1",
  turn_id: "turn-1",
  emit_id: "emit-1",
  seq: 2,
  mutations: [
    { kind: "part_delta", part_id: "thinking-1", field: "text", delta: "bc" },
    { kind: "stream_updated", state: "delta", display_metrics: { ...metrics, elapsed_ms: 32 } },
  ],
  ...patch,
});

describe("desktop live stream state", () => {
  test("updates only the changed Part and preserves unaffected references", () => {
    const current = activity();
    const originalParts = current.active!.stream!.process_parts;
    const result = applyDesktopStreamBatch(current, batch());
    expect(result.status).toBe("applied");
    expect(result.activity.active?.stream?.thinking).toBe("abc");
    expect(result.activity.active?.stream?.process_parts[0]).not.toBe(originalParts[0]);
    expect(result.activity.active?.stream?.process_parts[1]).toBe(originalParts[1]);
    expect(result.activity.active?.stream?.seq).toBe(2);
  });

  test("rejects sequence gaps and unknown Part deltas without guessing", () => {
    const current = activity();
    expect(applyDesktopStreamBatch(current, batch({ seq: 4 })).status).toBe("gap");
    expect(applyDesktopStreamBatch(current, batch({
      mutations: [{ kind: "part_delta", part_id: "missing", field: "text", delta: "x" }],
    })).status).toBe("gap");
    expect(current.active?.stream?.thinking).toBe("a");
  });

  test("ignores duplicate batches", () => {
    expect(applyDesktopStreamBatch(activity(), batch({ seq: 1 })).status).toBe("ignored");
  });
});
