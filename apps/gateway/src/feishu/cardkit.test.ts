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
  readonly calls: Array<{ method: string; path: string; body: JsonObject }> = [];
  failNext: FeishuCardKitError | undefined;

  async request(method: string, path: string, body: JsonObject): Promise<JsonObject> {
    this.calls.push({ method, path, body });
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = undefined;
      throw error;
    }
    if (path === "/cardkit/v1/cards") return { code: 0, data: { card_id: "card-1" } };
    if (path.includes("/im/v1/messages")) return { code: 0, data: { message_id: "om_card" } };
    return { code: 0 };
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

    expect(state.api.calls.filter((item) => item.path === "/cardkit/v1/cards")).toHaveLength(1);
    expect(state.api.calls.filter((item) => item.path.includes("/reply"))).toHaveLength(1);
    const sequences = state.api.calls
      .map((item) => item.body.sequence)
      .filter((item): item is number => typeof item === "number");
    expect(sequences).toEqual([1, 2]);
    expect(state.patches).toContainEqual({
      patch: { cardkit_card_id: "card-1", cardkit_emit_id: "emit-1" },
    });
    expect(state.patches).toContainEqual({
      deliveryHandle: { platform: "feishu", platform_message_id: "om_card" },
    });
  });

  test("final closes then replaces the card with thinking/tool/error semantics and cleans state", async () => {
    const state = setup();
    await state.cardkit.handle(request("delta", 1), state.route);
    await state.cardkit.handle(request("error", 2), state.route);
    const close = state.api.calls.find((item) => item.path.endsWith("/settings") && String(item.body.settings).includes("false"));
    const update = state.api.calls.find((item) => item.method === "PUT" && item.path === "/cardkit/v1/cards/card-1" && item.body.sequence === 3);
    expect(close?.body.sequence).toBe(2);
    expect(update?.body.sequence).toBe(3);
    expect(JSON.stringify(update?.body)).toContain("private reasoning");
    expect(JSON.stringify(update?.body)).toContain("部分思考内容已被模型隐藏");
    expect(JSON.stringify(update?.body)).toContain("Search");
    expect(JSON.stringify(update?.body)).toContain("生成失败");
    expect(state.patches.at(-1)).toEqual({ patch: { cardkit_card_id: "", cardkit_emit_id: "" } });
    await state.cardkit.handle(request("delta", 3), state.route);
    expect(state.api.calls.filter((item) => item.body.sequence === 4)).toHaveLength(0);
  });

  test("reopens once for 200850 and fails terminally for repeated or other API errors", async () => {
    const state = setup();
    await state.cardkit.handle(request("delta", 1), state.route);
    state.api.failNext = new FeishuCardKitError("stream_card_content", 200850, "card-1");
    await state.cardkit.handle(request("delta", 2), state.route);
    expect(state.api.calls.filter((item) => item.path.endsWith("/settings") && String(item.body.settings).includes("true"))).toHaveLength(1);

    state.api.failNext = new FeishuCardKitError("stream_card_content", 500, "card-1");
    await expect(state.cardkit.handle(request("delta", 3), state.route)).rejects.toThrow("500");
    await state.cardkit.handle(request("final", 4), state.route);
  });

  test("retries terminal close/finalize once after a recoverable reopen", async () => {
    const state = setup();
    await state.cardkit.handle(request("delta", 1), state.route);
    state.api.failNext = new FeishuCardKitError("close_streaming_mode", 200850, "card-1");
    await state.cardkit.handle(request("final", 2), state.route);
    expect(state.api.calls.filter((item) => item.path.endsWith("/settings") && String(item.body.settings).includes("true"))).toHaveLength(1);
    expect(state.api.calls.filter((item) => item.path.endsWith("/settings") && String(item.body.settings).includes("false"))).toHaveLength(2);
    expect(state.patches.at(-1)).toEqual({ patch: { cardkit_card_id: "", cardkit_emit_id: "" } });
  });

  test("serializes concurrent frames for the same session", async () => {
    const state = setup();
    await Promise.all([
      state.cardkit.handle(request("delta", 1), state.route),
      state.cardkit.handle(request("delta", 2), state.route),
      state.cardkit.handle(request("final", 3), state.route),
    ]);
    const sequences = state.api.calls.map((item) => item.body.sequence).filter((item) => typeof item === "number");
    expect(sequences).toEqual([1, 2, 3, 4]);
  });
});
