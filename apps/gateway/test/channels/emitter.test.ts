import { describe, expect, test } from "bun:test";
import type { EmitRequest } from "@lxe/protocol";
import { ChannelRegistry } from "../../src/channels/registry";
import { GatewayEmitter } from "../../src/channels/emitter";
import { FakeChannelAdapter } from "../fake-channel";

const emit = (patch: Record<string, unknown> = {}): EmitRequest => ({
  session_id: "session-1",
  turn_id: "turn-1",
  response_route_id: "route-1",
  content: "hello",
  thinking: "",
  redacted_thinking_count: 0,
  thinking_elapsed_ms: 0,
  tool_pending: false,
  tool_elapsed_ms: 0,
  tool_steps: [],
  files: [],
  emit_kind: "final",
  emit_id: "emit-1",
  stream_type: "",
  state: "",
  seq: 0,
  ...patch,
} as EmitRequest);

const setup = () => {
  const registry = new ChannelRegistry();
  const channel = new FakeChannelAdapter("feishu");
  registry.register(channel);
  const routes = {
    getSession: async () => ({ session_id: "session-1", source: { platform: "feishu" } }),
    getResponseRoute: async (id: string) => id === "missing" ? undefined : ({
      response_route_id: id,
      owner_user_id: "user",
      platform: "feishu",
      platform_message_id: null,
      conversation_id: "chat",
      conversation_type: "1",
      sender_nick: "Tester",
      extra_data: {},
      created_at: null,
      updated_at: null,
    }),
  };
  return { channel, emitter: new GatewayEmitter({ registry, routes }) };
};

describe("GatewayEmitter", () => {
  test("ignores progress and maps stream fields without losing thinking/tool data", async () => {
    const { channel, emitter } = setup();
    await emitter.emit(emit({ emit_kind: "progress" }));
    expect(channel.outbound).toHaveLength(0);
    await emitter.emit(emit({
      emit_kind: "stream",
      content: "delta",
      thinking: "reason",
      redacted_thinking_count: 1,
      thinking_elapsed_ms: 123,
      tool_pending: true,
      tool_elapsed_ms: 42,
      tool_steps: [{ id: "1", name: "web", title: "Search", detail: "", icon_token: "search_outlined", status: "running", duration_ms: 0 }],
      display_metrics: {
        status: "running",
        elapsed_ms: 123,
        model: "model-1",
        input_tokens: 1,
        output_tokens: 2,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        context_tokens: 1,
        context_window_tokens: 100,
      },
      stream_type: "final_answer",
      state: "delta",
      seq: 2,
    }));
    expect(channel.outbound).toEqual([expect.objectContaining({
      action: "stream_message",
      platform: "feishu",
      payload: expect.objectContaining({
        thinking: "reason",
        redacted_thinking_count: 1,
        tool_pending: true,
        seq: 2,
        display_metrics: expect.objectContaining({ model: "model-1" }),
      }),
    })]);
  });

  test("preserves tool-files-message and final-message-files ordering", async () => {
    const { channel, emitter } = setup();
    await emitter.emit(emit({
      emit_kind: "tool",
      files: ["/tmp/a.txt", "/tmp/b.txt"],
      content: "tool result",
    }));
    expect(channel.outbound.map((item) => item.action)).toEqual(["send_file", "send_file", "send_message"]);
    channel.outbound.length = 0;
    await emitter.emit(emit({ files: ["/tmp/final.txt"] }));
    expect(channel.outbound.map((item) => item.action)).toEqual(["send_message", "send_file"]);
  });

  test("accepts direct in-process Runtime requests", async () => {
    const { channel, emitter } = setup();
    await emitter.emit(emit({ content: "direct" }));
    await emitter.typing({
      session_id: "session-1",
      turn_id: "turn-1",
      response_route_id: "route-1",
      operation: "start",
      emit_id: "typing-direct",
    });
    expect(channel.outbound.map((item) => item.action)).toEqual(["send_message", "typing_indicator"]);
  });

  test("typing is Feishu-only, validates payloads and requires existing context", async () => {
    const { channel, emitter } = setup();
    await emitter.typing({
      session_id: "session-1",
      turn_id: "turn-1",
      response_route_id: "route-1",
      operation: "start",
      emit_id: "typing-1",
    });
    expect(channel.outbound[0]).toEqual(expect.objectContaining({ action: "typing_indicator", event_id: "typing-1" }));
    await expect(emitter.typing({
      session_id: "session-1",
      turn_id: "turn-1",
      response_route_id: "route-1",
      operation: "pulse",
    })).rejects.toThrow("operation");
    await expect(emitter.emit(emit({ response_route_id: "missing" }))).rejects.toThrow("response route");
    await expect(emitter.emit({ session_id: "session-1" } as EmitRequest)).rejects.toThrow("invalid runtime.emit");
  });
});
