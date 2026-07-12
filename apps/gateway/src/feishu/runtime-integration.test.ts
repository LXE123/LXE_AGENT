import { describe, expect, test } from "bun:test";
import type { JsonObject } from "@lxe/protocol";
import { ToolRegistry, TypeScriptAgentRuntime } from "@lxe/runtime";
import type { RuntimeHandle, RuntimeMessage, RuntimeStore } from "@lxe/runtime";
import { ChannelRegistry } from "../channel";
import { GatewayEmitter } from "../emitter";
import type { ResponseRoutePatch, ResponseRouteRecord } from "../models";
import { FeishuAdapter } from "./adapter";
import { loadFeishuConfig } from "./config";
import { FeishuApiHttpError } from "./response";
import type { FeishuSdkCallbacks, FeishuSdkServices } from "./sdk";

class IntegrationStore implements RuntimeStore {
  messages: RuntimeMessage[] = [];
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async getSession(_sessionId: string): Promise<{ session_id: string; source: JsonObject }> {
    return { session_id: "session-1", source: { platform: "feishu" } };
  }
  async loadMessages(): Promise<RuntimeMessage[]> { return structuredClone(this.messages); }
  async appendMessage(_sessionId: string, message: RuntimeMessage): Promise<void> { this.messages.push(message); }
  async replaceMessages(_sessionId: string, messages: RuntimeMessage[]): Promise<void> {
    this.messages = structuredClone(messages);
  }
  async patchSessionState(): Promise<void> {}
  async recordTurn(): Promise<void> {}
}

describe("Runtime to Feishu CardKit delivery", () => {
  test("creates and finalizes one streaming card without a legacy final card", async () => {
    const apiCalls: Array<{ operation: string; params: JsonObject }> = [];
    let route: ResponseRouteRecord = {
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
    };
    const routeStore = {
      getResponseRoute: async (_responseRouteId: string) => route,
      patchResponseRoute: async (_id: string, update: ResponseRoutePatch) => {
        route = {
          ...route,
          platform_message_id: update.deliveryHandle?.platform_message_id ?? route.platform_message_id,
          extra_data: { ...route.extra_data, ...(update.patch ?? {}) },
        };
      },
    };
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
    const adapter = new FeishuAdapter({
      config: loadFeishuConfig({ FEISHU_APP_ID: "cli-test", FEISHU_APP_SECRET: "secret" }),
      store: routeStore,
      sdkFactory,
    });
    const registry = new ChannelRegistry();
    registry.register(adapter);
    registry.wireInbound(async () => undefined);
    await registry.startAll();

    const store = new IntegrationStore();
    const emitter = new GatewayEmitter({
      registry,
      routes: {
        getSession: (sessionId) => store.getSession(sessionId),
        getResponseRoute: routeStore.getResponseRoute,
      },
    });
    const runtime = new TypeScriptAgentRuntime({
      store,
      tools: new ToolRegistry(),
      emitter,
      provider: {
        summarize: async () => ({ text: "summary", usage: { input_tokens: 0, output_tokens: 0 } }),
        turn: async (request) => {
          await request.onEvent?.({ type: "text_delta", text: "done" });
          return {
            content: [{ type: "text", text: "done" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        },
      },
      systemPrompt: "test",
    });
    const controller = new AbortController();
    const handle: RuntimeHandle = {
      signal: controller.signal,
      cancelled: false,
      drainSteering: () => [],
      registerProcess: () => () => undefined,
    };

    await runtime.start();
    await runtime.runTurn({
      job_id: "job-1",
      session_id: "session-1",
      session_key: "agent:main:feishu:dm:oc-chat",
      response_route_id: "route-1",
      user_id: "ou-user",
      conversation_id: "oc-chat",
      is_group: false,
      message_id: "om-source",
      user_input: "hello",
      job_kind: "turn",
      sender_nick: "Tester",
      source: { platform: "feishu" },
      raw_data: {},
      user_content_blocks: [],
    }, handle);

    expect(apiCalls.filter((call) => call.operation === "card.create")).toHaveLength(1);
    const replies = apiCalls.filter((call) => call.operation === "im.message.reply");
    expect(replies).toHaveLength(1);
    expect(replies[0]?.params.cardId).toBe("card-1");
    expect(apiCalls.some((call) => call.operation === "card.settings" && call.params.streamingMode === false)).toBe(true);
    expect(apiCalls.some((call) => call.operation === "card.update")).toBe(true);

    await runtime.stop();
    await registry.stopAll();
  });

  test("falls back to exactly one ordinary final when the initial CardKit reference is rejected", async () => {
    const calls: Array<{ operation: string; params: JsonObject }> = [];
    let route: ResponseRouteRecord = {
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
    };
    const routeStore = {
      getResponseRoute: async () => route,
      patchResponseRoute: async (_id: string, update: ResponseRoutePatch) => {
        route = {
          ...route,
          platform_message_id: update.deliveryHandle?.platform_message_id ?? route.platform_message_id,
          extra_data: { ...route.extra_data, ...(update.patch ?? {}) },
        };
      },
    };
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
            logId: "log-11310",
            operation: "send_stream_card_reply",
            message: "cardid is invalid",
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
    const adapter = new FeishuAdapter({
      config: loadFeishuConfig({ FEISHU_APP_ID: "cli-test", FEISHU_APP_SECRET: "secret" }),
      store: routeStore,
      sdkFactory,
    });
    const registry = new ChannelRegistry();
    registry.register(adapter);
    registry.wireInbound(async () => undefined);
    await registry.startAll();
    const store = new IntegrationStore();
    const runtime = new TypeScriptAgentRuntime({
      store,
      tools: new ToolRegistry(),
      emitter: new GatewayEmitter({
        registry,
        routes: { getSession: (sessionId) => store.getSession(sessionId), getResponseRoute: routeStore.getResponseRoute },
      }),
      provider: {
        summarize: async () => ({ text: "summary", usage: { input_tokens: 0, output_tokens: 0 } }),
        turn: async (providerRequest) => {
          await providerRequest.onEvent?.({ type: "text_delta", text: "done" });
          return {
            content: [{ type: "text", text: "done" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        },
      },
      systemPrompt: "test",
    });
    const controller = new AbortController();
    await runtime.start();
    const outcome = await runtime.runTurn({
      job_id: "job-fallback",
      session_id: "session-1",
      session_key: "agent:main:feishu:dm:oc-chat",
      response_route_id: "route-1",
      user_id: "ou-user",
      conversation_id: "oc-chat",
      is_group: false,
      message_id: "om-source",
      user_input: "hello",
      job_kind: "turn",
      sender_nick: "Tester",
      source: { platform: "feishu" },
      raw_data: {},
      user_content_blocks: [],
    }, {
      signal: controller.signal,
      cancelled: false,
      drainSteering: () => [],
      registerProcess: () => () => undefined,
    });

    expect(outcome.status).toBe("completed");
    expect(calls.filter((call) => call.operation === "card.reply")).toHaveLength(1);
    expect(calls.filter((call) => call.operation === "ordinary.reply")).toHaveLength(1);
    expect(JSON.stringify(calls.find((call) => call.operation === "ordinary.reply")?.params)).not.toContain("card-rejected");
    expect(route.extra_data).toEqual(expect.objectContaining({ cardkit_card_id: "", cardkit_emit_id: "" }));
    await runtime.stop();
    await registry.stopAll();
  });
});
