import { describe, expect, test } from "bun:test";
import { createLogger, type Logger } from "@lxe/core";
import type { JsonObject } from "@lxe/protocol";
import type { OutboundRequest } from "../../../src/state/models";
import { FeishuCardKit, FeishuCardKitError, type FeishuRouteContext } from "../../../src/channels/feishu/cardkit";
import { loadFeishuConfig } from "../../../src/channels/feishu/config";
import { FeishuApiHttpError } from "../../../src/channels/feishu/response";

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
  turn_id: "turn-1",
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
    tool_steps: [{ id: "t1", name: "search", title: "Search", detail: "ok", icon_token: "search_outlined", status: "success", duration_ms: 700 }],
    display_metrics: {
      status: state === "error" ? "error" : state === "final" ? "completed" : "running",
      elapsed_ms: 3200,
      model: "model-1",
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 2,
      cache_creation_input_tokens: 1,
      context_tokens: 12,
      context_window_tokens: 1000,
    },
    ...patch,
  },
});

class FakeApi {
  readonly calls: Array<{ operation: string; params: JsonObject }> = [];
  readonly sendFailures: Error[] = [];
  failNext: Error | undefined;
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
    const queuedFailure = this.sendFailures.shift();
    if (queuedFailure) {
      this.calls.push({ operation: "im.message.sendCardByReference", params });
      throw queuedFailure;
    }
    return this.execute("im.message.sendCardByReference", params, { code: 0, data: { message_id: "om_card" } });
  }
}

const setup = (options: { logger?: Logger; delay?: (milliseconds: number) => Promise<void> } = {}) => {
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
  return {
    api,
    patches,
    get route() { return context; },
    cardkit: new FeishuCardKit({
      api,
      store,
      display: loadFeishuConfig({}).cardDisplay,
      ...(options.logger ? { logger: options.logger } : {}),
      ...(options.delay ? { delay: options.delay } : {}),
    }),
  };
};

const invalidFreshCardReference = (message = "cardid is invalid"): FeishuApiHttpError =>
  new FeishuApiHttpError({
    method: "POST",
    path: "/im/v1/messages/om_source/reply",
    httpStatus: 400,
    apiCode: 230099,
    apiSubcode: 11310,
    logId: "log-11310",
    operation: "send_stream_card_reply",
    message: `Failed to create card content, ext=ErrCode: 11310; ErrMsg: ${message};`,
  });

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

  test("streams reasoning, switches structure for the answer, and skips unchanged content", async () => {
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
    expect(String(contentUpdates[0]?.params.content)).toContain("reasoning");
    const cardUpdates = state.api.calls.filter((item) => item.operation === "card.update");
    expect(JSON.stringify(cardUpdates.at(-1)?.params.card)).toContain("answer");
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
    await expect(state.cardkit.handle(request("final", 4), state.route)).rejects.toThrow("500");
  });

  test("reports malformed and nonzero API envelopes with the Feishu message", async () => {
    const denied = setup();
    denied.api.returnNext = { code: 999, msg: "permission denied", data: {} };
    await expect(denied.cardkit.handle(request("delta", 1), denied.route)).rejects.toThrow("permission denied");

    const malformed = setup();
    malformed.api.returnNext = { data: { card_id: "card-1" } };
    await expect(malformed.cardkit.handle(request("delta", 1), malformed.route)).rejects.toThrow("malformed Feishu response");
  });

  test("retries a fresh card reference twice at one-second intervals and keeps the same card", async () => {
    const lines: string[] = [];
    const delays: number[] = [];
    const logger = createLogger("test.cardkit", { write: (line) => lines.push(line) });
    const state = setup({ logger, delay: async (milliseconds) => { delays.push(milliseconds); } });
    state.api.sendFailures.push(invalidFreshCardReference(), invalidFreshCardReference());

    await state.cardkit.handle(request("delta", 1), state.route);

    const sends = state.api.calls.filter((item) => item.operation === "im.message.sendCardByReference");
    expect(state.api.calls.filter((item) => item.operation === "card.create")).toHaveLength(1);
    expect(sends).toHaveLength(3);
    expect(new Set(sends.map((item) => item.params.cardId))).toEqual(new Set(["card-1"]));
    expect(delays).toEqual([1_000, 1_000]);
    const records = lines.map((line) => JSON.parse(line));
    expect(records.filter((record) => record.message === "card_reference_retry_scheduled").map((record) => record.attempt))
      .toEqual([2, 3]);
    expect(records).toContainEqual(expect.objectContaining({
      message: "card_reference_retry_succeeded",
      attempt: 3,
      session_id: "session-1",
      turn_id: "turn-1",
      response_route_id: "route-1",
      emit_id: "emit-1",
      platform_message_id: "om_card",
    }));
  });

  test("continues streaming when the first fresh-card retry succeeds", async () => {
    const delays: number[] = [];
    const state = setup({ delay: async (milliseconds) => { delays.push(milliseconds); } });
    state.api.sendFailures.push(invalidFreshCardReference());

    await state.cardkit.handle(request("delta", 1), state.route);
    await state.cardkit.handle(request("final", 2), state.route);

    expect(state.api.calls.filter((item) => item.operation === "card.create")).toHaveLength(1);
    expect(state.api.calls.filter((item) => item.operation === "im.message.sendCardByReference")).toHaveLength(2);
    expect(delays).toEqual([1_000]);
    expect(state.api.calls.some((item) => item.operation === "card.settings")).toBe(true);
    expect(state.api.calls.some((item) => item.operation === "card.update")).toBe(true);
  });

  test("marks a fresh reference dead only after exhausting both retries", async () => {
    const lines: string[] = [];
    const delays: number[] = [];
    const logger = createLogger("test.cardkit", { write: (line) => lines.push(line) });
    const state = setup({ logger, delay: async (milliseconds) => { delays.push(milliseconds); } });
    state.api.sendFailures.push(
      invalidFreshCardReference(),
      invalidFreshCardReference(),
      invalidFreshCardReference(),
    );

    await expect(state.cardkit.handle(request("delta", 1), state.route)).rejects.toThrow("cardid is invalid");

    expect(state.api.calls.filter((item) => item.operation === "card.create")).toHaveLength(1);
    expect(state.api.calls.filter((item) => item.operation === "im.message.sendCardByReference")).toHaveLength(3);
    expect(delays).toEqual([1_000, 1_000]);
    expect(state.patches.at(-1)).toEqual({ patch: { cardkit_card_id: "", cardkit_emit_id: "" } });
    const records = lines.map((line) => JSON.parse(line));
    expect(records).toContainEqual(expect.objectContaining({
      message: "card_reference_retry_exhausted",
      attempts: 3,
      api_code: 230099,
      api_subcode: 11310,
      log_id: "log-11310",
    }));
    expect(records.filter((record) => record.message === "card_dead")).toHaveLength(1);
  });

  test("does not retry recovered cards or unrelated 230099/11310 failures", async () => {
    const recoveredDelays: number[] = [];
    const recovered = setup({ delay: async (milliseconds) => { recoveredDelays.push(milliseconds); } });
    recovered.route.extra_data.cardkit_card_id = "card-route";
    recovered.route.extra_data.cardkit_emit_id = "emit-1";
    recovered.api.sendFailures.push(invalidFreshCardReference());
    await expect(recovered.cardkit.handle(request("delta", 1), recovered.route)).rejects.toThrow("cardid is invalid");
    expect(recovered.api.calls.filter((item) => item.operation === "card.create")).toHaveLength(0);
    expect(recovered.api.calls.filter((item) => item.operation === "im.message.sendCardByReference")).toHaveLength(1);
    expect(recoveredDelays).toEqual([]);

    const tableLimitDelays: number[] = [];
    const tableLimit = setup({ delay: async (milliseconds) => { tableLimitDelays.push(milliseconds); } });
    tableLimit.api.sendFailures.push(invalidFreshCardReference("card table number over limit"));
    await expect(tableLimit.cardkit.handle(request("delta", 1), tableLimit.route)).rejects.toThrow("table number over limit");
    expect(tableLimit.api.calls.filter((item) => item.operation === "im.message.sendCardByReference")).toHaveLength(1);
    expect(tableLimitDelays).toEqual([]);
  });

  test("rejects non-string card ids before send and does not retain a ghost writer", async () => {
    const state = setup();
    state.api.returnNext = { code: 0, data: { card_id: 123 } };
    await expect(state.cardkit.handle(request("delta", 1), state.route)).rejects.toThrow("invalid card_id type: number");
    expect(state.api.calls.filter((item) => item.operation === "im.message.sendCardByReference")).toHaveLength(0);

    await state.cardkit.handle(request("delta", 2), state.route);
    expect(state.api.calls.filter((item) => item.operation === "card.create")).toHaveLength(2);
    expect(state.api.calls.filter((item) => item.operation === "im.message.sendCardByReference")).toHaveLength(1);
  });

  test("recovers only a matching route card and emits correlated reuse logs", async () => {
    const lines: string[] = [];
    const logger = createLogger("test.cardkit", { write: (line) => lines.push(line) });
    const recovered = setup({ logger });
    recovered.route.extra_data.cardkit_card_id = "card-route";
    recovered.route.extra_data.cardkit_emit_id = "emit-1";
    recovered.route.platform_message_id = "om-route";
    await recovered.cardkit.handle(request("delta", 1), recovered.route);
    expect(recovered.api.calls.filter((item) => item.operation === "card.create")).toHaveLength(0);
    const records = lines.map((line) => JSON.parse(line));
    expect(records).toContainEqual(expect.objectContaining({
      message: "card_recovered_route",
      session_id: "session-1",
      turn_id: "turn-1",
      response_route_id: "route-1",
      emit_id: "emit-1",
    }));

    const mismatched = setup({ logger });
    mismatched.route.extra_data.cardkit_card_id = "card-stale";
    mismatched.route.extra_data.cardkit_emit_id = "emit-old";
    mismatched.route.platform_message_id = "om-stale";
    await mismatched.cardkit.handle(request("delta", 1), mismatched.route);
    expect(mismatched.api.calls.filter((item) => item.operation === "card.create")).toHaveLength(1);
    expect(lines.map((line) => JSON.parse(line))).toContainEqual(expect.objectContaining({
      message: "card_reuse_rejected_emit_mismatch",
      requested_emit_id: "emit-1",
    }));
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
