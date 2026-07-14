import { describe, expect, test } from "bun:test";
import { loadFeishuConfig } from "../../../src/channels/feishu/config";
import { createOfficialFeishuSdk, FEISHU_EVENT_TYPES } from "../../../src/channels/feishu/sdk";
import { FeishuApiHttpError } from "../../../src/channels/feishu/response";

describe("official Feishu SDK factory", () => {
  test("constructs Client/WSClient/EventDispatcher and registers required events", async () => {
    const registered: Record<string, (value: unknown) => unknown> = {};
    const starts: unknown[] = [];
    const closes: unknown[] = [];
    const typedCalls: Array<{ operation: string; payload: unknown }> = [];
    let clientOptions: Record<string, unknown> = {};
    let dispatcherOptions: Record<string, unknown> = {};
    let wsOptions: Record<string, unknown> = {};
    let apiResponse: unknown = { code: 0, msg: "success", data: { message_id: "om-raw" } };
    let apiError: unknown;
    let typedApiError: unknown;
    class Client {
      cardkit = { v1: {
        card: {
          create: async (payload: unknown) => {
            typedCalls.push({ operation: "card.create", payload });
            return { code: 0, msg: "success", data: { card_id: "card-typed" } };
          },
          update: async (payload: unknown) => {
            typedCalls.push({ operation: "card.update", payload });
            return { code: 0, msg: "success", data: {} };
          },
          settings: async (payload: unknown) => {
            typedCalls.push({ operation: "card.settings", payload });
            return { code: 0, msg: "success", data: {} };
          },
        },
        cardElement: {
          content: async (payload: unknown) => {
            typedCalls.push({ operation: "cardElement.content", payload });
            if (typedApiError) throw typedApiError;
            return { code: 0, msg: "success", data: {} };
          },
        },
      } };
      im = { v1: {
        message: {
          reply: async (payload: unknown) => {
            typedCalls.push({ operation: "im.message.reply", payload });
            return { code: 0, msg: "success", data: { message_id: "om-reply" } };
          },
          create: async (payload: unknown) => {
            typedCalls.push({ operation: "im.message.create", payload });
            return { code: 0, msg: "success", data: { message_id: "om-create" } };
          },
        },
        messageReaction: { create: async () => ({ data: { reaction_id: "r" } }), delete: async () => ({}) },
        file: { create: async () => ({ file_key: "f" }) },
        image: { create: async () => ({ image_key: "i" }) },
      } };
      request = async () => {
        if (apiError) throw apiError;
        return apiResponse;
      };
      constructor(readonly options: unknown) {
        clientOptions = options as Record<string, unknown>;
      }
    }
    class EventDispatcher {
      constructor(readonly options: unknown) { dispatcherOptions = options as Record<string, unknown>; }
      register(handlers: Record<string, (value: unknown) => unknown>) {
        Object.assign(registered, handlers);
        return this;
      }
    }
    class WSClient {
      constructor(readonly options: unknown) { wsOptions = options as Record<string, unknown>; }
      async start(value: unknown) { starts.push(value); }
      close(value?: unknown) { closes.push(value); }
      getConnectionStatus() { return { state: "connected", reconnectAttempts: 0 }; }
    }
    const config = loadFeishuConfig({ FEISHU_APP_ID: "cli_test", FEISHU_APP_SECRET: "secret" });
    const callbacks: string[] = [];
    const sdk = createOfficialFeishuSdk(config, {
      onMessage: async () => { callbacks.push("message"); },
      onReactionCreated: async () => { callbacks.push("reaction-created"); },
      onReactionDeleted: async () => { callbacks.push("reaction-deleted"); },
      onReady: () => callbacks.push("ready"),
      onError: () => callbacks.push("error"),
      onReconnecting: () => callbacks.push("reconnecting"),
      onReconnected: () => callbacks.push("reconnected"),
    }, { Client, EventDispatcher, WSClient } as never);

    expect(Object.keys(registered).sort()).toEqual([...FEISHU_EVENT_TYPES].sort());
    expect(clientOptions.loggerLevel).toBe(0);
    expect(dispatcherOptions.loggerLevel).toBe(0);
    expect(wsOptions.loggerLevel).toBe(0);
    expect(clientOptions.logger).toBe(wsOptions.logger);
    await registered["im.message.receive_v1"]?.({});
    await registered["im.message.reaction.created_v1"]?.({});
    await registered["im.message.reaction.deleted_v1"]?.({});
    expect(callbacks.slice(0, 3)).toEqual(["message", "reaction-created", "reaction-deleted"]);
    expect(await sdk.api.request("POST", "/im/v1/messages/om-source/reply", {})).toEqual({
      code: 0,
      msg: "success",
      data: { message_id: "om-raw" },
      log_id: "",
    });
    apiResponse = { data: { message_id: "missing-code" } };
    await expect(sdk.api.request("POST", "/im/v1/messages/om-source/reply", {})).rejects.toThrow("malformed Feishu response");
    apiError = Object.assign(new Error("Request failed with status code 400"), {
      name: "AxiosError",
      code: "ERR_BAD_REQUEST",
      response: {
        status: 400,
        data: { code: 200000, msg: "invalid card data token=private", log_id: "log-http-1" },
      },
    });
    await expect(sdk.api.request("POST", "/im/v1/messages/om-source/reply", {})).rejects.toThrow(
      "Feishu API POST /im/v1/messages/om-source/reply failed: HTTP 400, code 200000: invalid card data token=[redacted]",
    );
    const structured = await sdk.api.request("POST", "/im/v1/messages/om-source/reply", {}).catch((error) => error);
    expect(structured).toBeInstanceOf(FeishuApiHttpError);
    expect(structured).toEqual(expect.objectContaining({
      method: "POST",
      http_status: 400,
      api_code: 200000,
      api_subcode: -1,
      log_id: "log-http-1",
      operation: "api_request",
    }));
    apiError = Object.assign(new Error("Request failed with status code 400"), {
      name: "AxiosError",
      response: {
        status: 400,
        data: {
          code: 230099,
          msg: "Failed to create card content, ext=ErrCode: 11310; ErrMsg: cardid is invalid;",
          error: { log_id: "log-nested-11310" },
        },
      },
    });
    const nestedStructured = await sdk.api.request("POST", "/im/v1/messages/om-source/reply", {}).catch((error) => error);
    expect(nestedStructured).toEqual(expect.objectContaining({
      http_status: 400,
      api_code: 230099,
      api_subcode: 11310,
      log_id: "log-nested-11310",
      operation: "api_request",
    }));
    apiError = undefined;

    const card = { schema: "2.0", config: { streaming_mode: true }, body: { elements: [] } };
    expect(await sdk.cardkit.createCardEntity(card)).toEqual({
      code: 0,
      msg: "success",
      data: { card_id: "card-typed" },
      log_id: "",
    });
    await sdk.cardkit.streamCardContent({
      cardId: "card-typed",
      elementId: "streaming_content",
      content: "hello",
      sequence: 1,
    });
    await sdk.cardkit.updateCard({ cardId: "card-typed", card, sequence: 2 });
    await sdk.cardkit.setStreamingMode({ cardId: "card-typed", streamingMode: false, sequence: 3 });
    await sdk.cardkit.sendCardByReference({
      conversationId: "oc-chat",
      sourceMessageId: "om-source",
      cardId: "card-typed",
    });
    await sdk.cardkit.sendCardByReference({
      conversationId: "oc-chat",
      sourceMessageId: "",
      cardId: "card-typed",
    });

    expect(typedCalls).toEqual([
      {
        operation: "card.create",
        payload: { data: { type: "card_json", data: JSON.stringify(card) } },
      },
      {
        operation: "cardElement.content",
        payload: {
          data: { content: "hello", sequence: 1, uuid: "stream_card-typed_1" },
          path: { card_id: "card-typed", element_id: "streaming_content" },
        },
      },
      {
        operation: "card.update",
        payload: {
          data: {
            card: { type: "card_json", data: JSON.stringify(card) },
            sequence: 2,
            uuid: "update_card-typed_2",
          },
          path: { card_id: "card-typed" },
        },
      },
      {
        operation: "card.settings",
        payload: {
          data: {
            settings: JSON.stringify({ config: { streaming_mode: false } }),
            sequence: 3,
            uuid: "close_card-typed_3",
          },
          path: { card_id: "card-typed" },
        },
      },
      {
        operation: "im.message.reply",
        payload: {
          path: { message_id: "om-source" },
          data: {
            msg_type: "interactive",
            content: JSON.stringify({ type: "card", data: { card_id: "card-typed" } }),
          },
        },
      },
      {
        operation: "im.message.create",
        payload: {
          params: { receive_id_type: "chat_id" },
          data: {
            receive_id: "oc-chat",
            msg_type: "interactive",
            content: JSON.stringify({ type: "card", data: { card_id: "card-typed" } }),
          },
        },
      },
    ]);
    typedApiError = Object.assign(new Error("Request failed with status code 400"), {
      response: { status: 400, data: { code: 99992402, msg: "field validation failed" } },
    });
    await expect(sdk.cardkit.streamCardContent({
      cardId: "card-typed",
      elementId: "streaming_content",
      content: "bad",
      sequence: 4,
    })).rejects.toThrow(
      "Feishu API PUT /cardkit/v1/cards/card-typed/elements/streaming_content/content failed: HTTP 400, code 99992402: field validation failed",
    );
    await sdk.connection.start();
    expect(starts).toHaveLength(1);
    expect(sdk.connection.status()).toEqual(expect.objectContaining({ state: "connected" }));
    await sdk.connection.stop(true);
    expect(closes).toEqual([{ force: true }]);
  });
});
