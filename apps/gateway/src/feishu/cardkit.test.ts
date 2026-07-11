import { describe, expect, test } from "bun:test";
import type { JsonObject } from "@lxe/protocol";
import type { OutboundRequest } from "../models";
import { FeishuCardKit, FeishuCardKitError, type FeishuRouteContext } from "./cardkit";

const route = (): FeishuRouteContext => ({
  response_route_id: "route-1",
  platform_message_id: "",
  owner_user_id: "ou_user",
  conversation_id: "oc_chat",
  conversation_type: "2",
  sender_nick: "Tester",
  message_id: "om_source",
  extra_data: { source_message_id: "om_source" },
});

const request = (state: "delta" | "final" | "error", seq: number, patch: JsonObject = {}): OutboundRequest => ({
  action: "stream_message",
  platform: "feishu",
  session_id: "session-1",
  response_route_id: "route-1",
  event_id: "emit-1",
  payload: {
    stream_type: "final_answer",
    state,
    seq,
    content: state === "delta" ? `answer-${seq}` : "done",
    thinking: "private reasoning",
    redacted_thinking_count: 1,
    thinking_elapsed_ms: 2_100,
    tool_pending: false,
    tool_elapsed_ms: 800,
    tool_steps: [{ id: "t1", name: "search", title: "Search", detail: "ok", status: "success", duration_ms: 700 }],
    ...patch,
  },
});

class FakeApi {
  readonly calls: Array<{ operation: string; params: JsonObject }> = [];
  failNext: FeishuCardKitError | undefined;
  returnNext: JsonObject | undefined;

  private async execute(operation: string, params: JsonObject, fallback: JsonObject): Promise<JsonObject> {
    this.calls.push({ operation, params });
    if (this.returnNext) {
      const result = this.returnNext;
      this.returnNext = undefined;
      return result;
    }
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = undefined;
      throw error;
    }
    return fallback;
  }

  async createCardEntity(card: JsonObject): Promise<JsonObject> {
    return this.execute("card.create", { card }, { code: 0, data: { card_id: "card-1" } });
  }

  async streamCardContent(params: { cardId: string; elementId: string; content: string; sequence: number }): Promise<JsonObject> {
    return this.execute("cardElement.content", params, { code: 0 });
  }

  async updateCard(params: { cardId: string; card: JsonObject; sequence: number }): Promise<JsonObject> {
    return this.execute("card.update", params, { code: 0 });
  }

  async setStreamingMode(params: { cardId: string; streamingMode: boolean; sequence: number }): Promise<JsonObject> {
    return this.execute("card.settings", params, { code: 0 });
  }

  async sendCardByReference(params: { conversationId: string; sourceMessageId: string; cardId: string }): Promise<JsonObject> {
    return this.execute("im.message.sendCardByReference", params, { code: 0, data: { message_id: "om_card" } });
  }
}

const setup = () => {
  const api = new FakeApi();
  let context = route();
  const patches: JsonObject[] = [];
  const store = {
    patchResponseRoute: async (_id: string, update: { patch?: JsonObject; deliveryHandle?: { platform?: string; platform_message_id?: string } }) => {
      patches.push(update as unknown as JsonObject);
      context = {
        ...context,
        platform_message_id: update.deliveryHandle?.platform_message_id ?? context.platform_message_id,
        extra_data: { ...context.extra_data, ...(update.patch ?? {}) },
      };
    },
  };
  return { api, patches, get route() { return context; }, cardkit: new FeishuCardKit({ api, store }) };
};

describe("Feishu CardKit stream state", () => {
  test("creates/replies once, rejects stale frames and uses monotonic card sequences", async () => {
    const state = setup();
    await state.cardkit.handle(request("delta", 1), state.route);
    await state.cardkit.handle(request("delta", 1), state.route);
    await state.cardkit.handle(request("delta", 2), state.route);

    expect(state.api.calls.filter((item) => item.operation === "card.create")).toHaveLength(1);
    expect(state.api.calls.filter((item) => item.operation === "im.message.sendCardByReference")).toHaveLength(1);
    const createdCard = state.api.calls.find((item) => item.operation === "card.create")?.params.card;
    expect(createdCard).toEqual(expect.objectContaining({
      schema: "2.0",
      config: expect.objectContaining({
        streaming_mode: true,
        locales: ["zh_cn", "en_us"],
      }),
    }));
    expect(JSON.stringify(createdCard)).toContain("streaming_content");
    expect(JSON.stringify(createdCard)).toContain("loading_icon");
    expect(state.api.calls.find((item) => item.operation === "cardElement.content")?.params.elementId)
      .toBe("streaming_content");
    const sequences = state.api.calls
      .map((item) => item.params.sequence)
      .filter((item): item is number => typeof item === "number");
    expect(sequences).toEqual([1, 2]);
    expect(state.patches).toContainEqual({
      patch: { cardkit_card_id: "card-1", cardkit_emit_id: "emit-1" },
    });
    expect(state.patches).toContainEqual({
      deliveryHandle: { platform: "feishu", platform_message_id: "om_card" },
    });
  });

  test("does not send an empty or unchanged element-content update during thinking", async () => {
    const state = setup();
    await state.cardkit.handle(request("delta", 1, {
      content: "",
      thinking: "",
      tool_pending: true,
      tool_steps: [],
    }), state.route);
    await state.cardkit.handle(request("delta", 2, {
      content: "",
      thinking: "reasoning",
      tool_pending: true,
      tool_steps: [],
    }), state.route);
    await state.cardkit.handle(request("delta", 3, {
      content: "answer",
      thinking: "reasoning",
      tool_pending: true,
      tool_steps: [],
    }), state.route);
    await state.cardkit.handle(request("delta", 4, {
      content: "answer",
      thinking: "more reasoning",
      tool_pending: true,
      tool_steps: [],
    }), state.route);

    const contentUpdates = state.api.calls.filter((item) => item.operation === "cardElement.content");
    expect(contentUpdates).toHaveLength(1);
    expect(contentUpdates[0]?.params.content).toBe("answer");
  });

  test("final closes then replaces the card with thinking/tool/error semantics and cleans state", async () => {
    const state = setup();
    await state.cardkit.handle(request("delta", 1), state.route);
    await state.cardkit.handle(request("error", 2), state.route);
    const close = state.api.calls.find((item) => item.operation === "card.settings" && item.params.streamingMode === false);
    const update = state.api.calls.find((item) => item.operation === "card.update" && item.params.sequence === 3);
    expect(close?.params.sequence).toBe(2);
    expect(update?.params.sequence).toBe(3);
    expect(JSON.stringify(update?.params)).toContain("private reasoning");
    expect(JSON.stringify(update?.params)).toContain("部分思考内容已被模型隐藏");
    expect(JSON.stringify(update?.params)).toContain("Search");
    expect(JSON.stringify(update?.params)).toContain("生成失败");
    expect(state.patches.at(-1)).toEqual({ patch: { cardkit_card_id: "", cardkit_emit_id: "" } });
    await state.cardkit.handle(request("delta", 3), state.route);
    expect(state.api.calls.filter((item) => item.params.sequence === 4)).toHaveLength(0);
  });

  test("reopens once for 200850 and fails terminally for repeated or other API errors", async () => {
    const state = setup();
    await state.cardkit.handle(request("delta", 1), state.route);
    state.api.failNext = new FeishuCardKitError("stream_card_content", 200850, "card-1");
    await state.cardkit.handle(request("delta", 2), state.route);
    expect(state.api.calls.filter((item) => item.operation === "card.settings" && item.params.streamingMode === true)).toHaveLength(1);

    state.api.failNext = new FeishuCardKitError("stream_card_content", 500, "card-1");
    await expect(state.cardkit.handle(request("delta", 3), state.route)).rejects.toThrow("500");
    await state.cardkit.handle(request("final", 4), state.route);
  });

  test("reports malformed and nonzero API envelopes with the Feishu message", async () => {
    const denied = setup();
    denied.api.returnNext = { code: 999, msg: "permission denied", data: {} };
    await expect(denied.cardkit.handle(request("delta", 1), denied.route)).rejects.toThrow("permission denied");

    const malformed = setup();
    malformed.api.returnNext = { data: { card_id: "card-1" } };
    await expect(malformed.cardkit.handle(request("delta", 1), malformed.route)).rejects.toThrow("malformed Feishu response");
  });

  test("retries terminal close/finalize once after a recoverable reopen", async () => {
    const state = setup();
    await state.cardkit.handle(request("delta", 1), state.route);
    state.api.failNext = new FeishuCardKitError("close_streaming_mode", 200850, "card-1");
    await state.cardkit.handle(request("final", 2), state.route);
    expect(state.api.calls.filter((item) => item.operation === "card.settings" && item.params.streamingMode === true)).toHaveLength(1);
    expect(state.api.calls.filter((item) => item.operation === "card.settings" && item.params.streamingMode === false)).toHaveLength(2);
    expect(state.patches.at(-1)).toEqual({ patch: { cardkit_card_id: "", cardkit_emit_id: "" } });
  });

  test("serializes concurrent frames for the same session", async () => {
    const state = setup();
    await Promise.all([
      state.cardkit.handle(request("delta", 1), state.route),
      state.cardkit.handle(request("delta", 2), state.route),
      state.cardkit.handle(request("final", 3), state.route),
    ]);
    const sequences = state.api.calls.map((item) => item.params.sequence).filter((item) => typeof item === "number");
    expect(sequences).toEqual([1, 2, 3, 4]);
  });
});
