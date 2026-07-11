import { describe, expect, test } from "bun:test";
import { loadFeishuConfig } from "./config";
import { createOfficialFeishuSdk, FEISHU_EVENT_TYPES } from "./sdk";

describe("official Feishu SDK factory", () => {
  test("constructs Client/WSClient/EventDispatcher and registers required events", async () => {
    const registered: Record<string, (value: unknown) => unknown> = {};
    const starts: unknown[] = [];
    const closes: unknown[] = [];
    class Client {
      im = { v1: {
        messageReaction: { create: async () => ({ data: { reaction_id: "r" } }), delete: async () => ({}) },
        file: { create: async () => ({ file_key: "f" }) },
        image: { create: async () => ({ image_key: "i" }) },
      } };
      request = async () => ({ data: { code: 0 } });
      constructor(readonly options: unknown) {}
    }
    class EventDispatcher {
      constructor(readonly options: unknown) {}
      register(handlers: Record<string, (value: unknown) => unknown>) {
        Object.assign(registered, handlers);
        return this;
      }
    }
    class WSClient {
      constructor(readonly options: unknown) {}
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
    await registered["im.message.receive_v1"]?.({});
    await registered["im.message.reaction.created_v1"]?.({});
    await registered["im.message.reaction.deleted_v1"]?.({});
    expect(callbacks.slice(0, 3)).toEqual(["message", "reaction-created", "reaction-deleted"]);
    await sdk.connection.start();
    expect(starts).toHaveLength(1);
    expect(sdk.connection.status()).toEqual(expect.objectContaining({ state: "connected" }));
    await sdk.connection.stop(true);
    expect(closes).toEqual([{ force: true }]);
  });
});
