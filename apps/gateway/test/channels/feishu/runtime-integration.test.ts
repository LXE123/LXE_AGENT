import { describe, expect, test } from "bun:test";
import type { EmitRequest, JsonObject } from "@lxe/protocol";
import { ChannelRegistry } from "../../../src/channels/registry";
import { GatewayEmitter } from "../../../src/channels/emitter";
import type { ResponseRoutePatch, ResponseRouteRecord } from "../../../src/state/models";
import { FeishuAdapter } from "../../../src/channels/feishu/adapter";
import { loadFeishuConfig } from "../../../src/channels/feishu/config";
import type { InboundImageProcessorPort } from "../../../src/channels/feishu/image-contract";
import { FeishuApiHttpError } from "../../../src/channels/feishu/response";
import type { FeishuSdkCallbacks, FeishuSdkServices } from "../../../src/channels/feishu/sdk";

const unusedImageProcessor: InboundImageProcessorPort = {
  process: async () => {
    throw new Error("unexpected image processing in CardKit delivery test");
  },
};

const frame = (state: "delta" | "final", seq: number): EmitRequest => ({
  session_id: "session-1",
  turn_id: "turn-1",
  response_route_id: "route-1",
  content: "done",
  thinking: "",
  redacted_thinking_count: 0,
  thinking_elapsed_ms: 0,
  tool_pending: false,
  tool_elapsed_ms: 0,
  tool_steps: [],
  files: [],
  emit_id: "emit-1",
  emit_kind: "stream",
  stream_type: "final_answer",
  state,
  seq,
  display_metrics: {
    status: state === "final" ? "completed" : "running",
    elapsed_ms: 1,
    model: "test-model",
    input_tokens: 1,
    output_tokens: 1,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    context_tokens: 1,
    context_window_tokens: 100,
  },
});

const initialRoute = (): ResponseRouteRecord => ({
  response_route_id: "route-1",
  owner_user_id: "ou-user",
  platform: "feishu",
  platform_message_id: null,
  conversation_id: "oc-chat",
  conversation_type: "1",
  sender_nick: "Tester",
  extra_data: { source_message_id: "om-source" },
  created_at: null,
  updated_at: null,
});

const routeStore = (initial: ResponseRouteRecord) => {
  let route = initial;
  return {
    get route(): ResponseRouteRecord { return route; },
    getResponseRoute: async (_responseRouteId: string) => route,
    patchResponseRoute: async (_id: string, update: ResponseRoutePatch) => {
      route = {
        ...route,
        platform_message_id: update.deliveryHandle?.platform_message_id ?? route.platform_message_id,
        extra_data: { ...route.extra_data, ...(update.patch ?? {}) },
      };
    },
  };
};

const startDelivery = async (
  store: ReturnType<typeof routeStore>,
  sdkFactory: (callbacks: FeishuSdkCallbacks) => FeishuSdkServices,
) => {
  const adapter = new FeishuAdapter({
    config: loadFeishuConfig({ FEISHU_APP_ID: "cli-test", FEISHU_APP_SECRET: "secret" }),
    store,
    imageProcessor: unusedImageProcessor,
    sdkFactory,
    delay: async () => undefined,
  });
  const registry = new ChannelRegistry();
  registry.register(adapter);
  registry.wireInbound(async () => undefined);
  await registry.startAll();
  const emitter = new GatewayEmitter({
    registry,
    routes: {
      getSession: async () => ({ session_id: "session-1", source: { platform: "feishu" } }),
      getResponseRoute: store.getResponseRoute,
    },
  });
  return { emitter, registry };
};

describe("Gateway emitter to Feishu CardKit delivery", () => {
  test("creates and finalizes one streaming card from outbound intents", async () => {
    const apiCalls: Array<{ operation: string; params: JsonObject }> = [];
    const store = routeStore(initialRoute());
    const sdkFactory = (callbacks: FeishuSdkCallbacks): FeishuSdkServices => ({
      api: {
        request: async () => ({ code: 0, msg: "success", data: {} }),
        upload: async () => "file-key",
      },
      cardkit: {
        createCardEntity: async (card) => {
          apiCalls.push({ operation: "card.create", params: { card } });
          return { code: 0, msg: "success", data: { card_id: "card-1" } };
        },
        streamCardContent: async (params) => {
          apiCalls.push({ operation: "cardElement.content", params });
          return { code: 0, msg: "success", data: {} };
        },
        updateCard: async (params) => {
          apiCalls.push({ operation: "card.update", params });
          return { code: 0, msg: "success", data: {} };
        },
        setStreamingMode: async (params) => {
          apiCalls.push({ operation: "card.settings", params });
          return { code: 0, msg: "success", data: {} };
        },
        sendCardByReference: async (params) => {
          apiCalls.push({ operation: "im.message.reply", params });
          return { code: 0, msg: "success", data: { message_id: "om-card" } };
        },
      },
      reactions: { add: async () => "reaction-1", remove: async () => undefined },
      connection: {
        start: async () => callbacks.onReady(),
        stop: async () => undefined,
        status: () => ({ state: "connected" }),
      },
      probeBotIdentity: async () => ({ openId: "ou-bot", name: "Bot" }),
    });
    const { emitter, registry } = await startDelivery(store, sdkFactory);

    await emitter.emit(frame("delta", 1));
    await emitter.emit(frame("final", 2));

    expect(apiCalls.filter((call) => call.operation === "card.create")).toHaveLength(1);
    const replies = apiCalls.filter((call) => call.operation === "im.message.reply");
    expect(replies).toHaveLength(1);
    expect(replies[0]?.params.cardId).toBe("card-1");
    expect(apiCalls.some((call) => call.operation === "card.settings" && call.params.streamingMode === false)).toBe(true);
    expect(apiCalls.some((call) => call.operation === "card.update")).toBe(true);
    expect(store.route.extra_data).toEqual(expect.objectContaining({ cardkit_card_id: "", cardkit_emit_id: "" }));

    await registry.stopAll();
  });

  test("propagates a rejected CardKit reference after bounded retries and clears route state", async () => {
    const calls: Array<{ operation: string; params: JsonObject }> = [];
    const store = routeStore(initialRoute());
    const sdkFactory = (callbacks: FeishuSdkCallbacks): FeishuSdkServices => ({
      api: {
        request: async (_method, _path, body) => {
          calls.push({ operation: "ordinary.reply", params: body });
          return { code: 0, msg: "success", data: { message_id: "om-fallback" } };
        },
        upload: async () => "file-key",
      },
      cardkit: {
        createCardEntity: async () => ({ code: 0, msg: "success", data: { card_id: "card-rejected" } }),
        streamCardContent: async () => ({ code: 0, msg: "success", data: {} }),
        updateCard: async () => ({ code: 0, msg: "success", data: {} }),
        setStreamingMode: async () => ({ code: 0, msg: "success", data: {} }),
        sendCardByReference: async (params) => {
          calls.push({ operation: "card.reply", params });
          throw new FeishuApiHttpError({
            method: "POST",
            path: "/im/v1/messages/om-source/reply",
            httpStatus: 400,
            apiCode: 230099,
            apiSubcode: 11310,
            logId: "log-11310",
            operation: "send_stream_card_reply",
            message: "Failed to create card content, ext=ErrCode: 11310; ErrMsg: cardid is invalid;",
          });
        },
      },
      reactions: { add: async () => "reaction-1", remove: async () => undefined },
      connection: {
        start: async () => callbacks.onReady(),
        stop: async () => undefined,
        status: () => ({ state: "connected" }),
      },
      probeBotIdentity: async () => ({ openId: "ou-bot", name: "Bot" }),
    });
    const { emitter, registry } = await startDelivery(store, sdkFactory);

    await expect(emitter.emit(frame("delta", 1))).rejects.toThrow("cardid is invalid");

    expect(calls.filter((call) => call.operation === "card.reply")).toHaveLength(3);
    expect(calls.filter((call) => call.operation === "ordinary.reply")).toHaveLength(0);
    expect(store.route.extra_data).toEqual(expect.objectContaining({ cardkit_card_id: "", cardkit_emit_id: "" }));

    await registry.stopAll();
  });
});
