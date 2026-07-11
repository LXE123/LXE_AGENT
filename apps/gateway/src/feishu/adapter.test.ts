import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { JsonObject } from "@lxe/protocol";
import type { OutboundRequest } from "../models";
import { loadFeishuConfig } from "./config";
import { FeishuAdapter } from "./adapter";
import type { FeishuSdkCallbacks, FeishuSdkServices } from "./sdk";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

const route = {
  response_route_id: "route-1",
  owner_user_id: "ou_user",
  platform: "feishu",
  platform_message_id: null,
  conversation_id: "oc_chat",
  conversation_type: "1",
  sender_nick: "Tester",
  extra_data: { source_message_id: "om_source" },
  created_at: null,
  updated_at: null,
};

const outbound = (action: string, payload: JsonObject): OutboundRequest => ({
  action,
  platform: "feishu",
  payload,
  session_id: "session-1",
  response_route_id: "route-1",
  event_id: "emit-1",
});

const setup = (options: { failStart?: boolean; hangStart?: boolean; hangStop?: boolean; projectRoot?: string; rawDump?: boolean } = {}) => {
  let callbacks!: FeishuSdkCallbacks;
  const calls: string[] = [];
  const apiCalls: string[] = [];
  const services: FeishuSdkServices = {
    connection: {
      start: async () => {
        calls.push("start");
        if (options.failStart) throw new Error("connect failed");
        if (options.hangStart) await new Promise(() => undefined);
        callbacks.onReady();
      },
      stop: async (force) => {
        calls.push(`stop:${Boolean(force)}`);
        if (options.hangStop && !force) await new Promise(() => undefined);
      },
      status: () => ({ state: "connected", reconnectAttempts: 0 }),
    },
    api: {
      request: async (method, path) => {
        apiCalls.push(`${method}:${path}`);
        return { code: 0, data: { message_id: "om_sent" } };
      },
      upload: async (_path, kind) => `${kind}_key`,
    },
    cardkit: {
      createCardEntity: async () => {
        apiCalls.push("cardkit:card.create");
        return { code: 0, data: { card_id: "card-1" } };
      },
      streamCardContent: async () => {
        apiCalls.push("cardkit:cardElement.content");
        return { code: 0 };
      },
      updateCard: async () => {
        apiCalls.push("cardkit:card.update");
        return { code: 0 };
      },
      setStreamingMode: async () => {
        apiCalls.push("cardkit:card.settings");
        return { code: 0 };
      },
      sendCardByReference: async () => {
        apiCalls.push("cardkit:im.message.reply");
        return { code: 0, data: { message_id: "om_sent" } };
      },
    },
    reactions: {
      add: async () => "reaction-1",
      remove: async () => undefined,
    },
    probeBotIdentity: async () => ({ openId: "ou_bot", name: "LXE" }),
  };
  const store = {
    getResponseRoute: async (id: string) => id === "route-1" ? route : undefined,
    patchResponseRoute: async () => undefined,
  };
  const adapter = new FeishuAdapter({
    config: loadFeishuConfig({
      FEISHU_APP_ID: "cli_test",
      FEISHU_APP_SECRET: "secret",
      FEISHU_WS_AUTO_RESTART_ENABLED: "false",
      ...(options.rawDump ? { LOCAL_LOGS_ENABLED: "1" } : {}),
    }),
    store,
    sdkFactory: (value) => { callbacks = value; return services; },
    stopTimeoutMs: 5,
    ...(options.projectRoot ? { projectRoot: options.projectRoot } : {}),
  });
  return { adapter, calls, apiCalls, get callbacks() { return callbacks; } };
};

describe("FeishuAdapter lifecycle and delivery", () => {
  test("registers inbound sink, starts idempotently, handles reconnect health and stops idempotently", async () => {
    const state = setup();
    const inbound: unknown[] = [];
    state.adapter.setInboundSink(async (event) => { inbound.push(event); });
    await Promise.all([state.adapter.start(), state.adapter.start()]);
    expect(state.calls).toEqual(["start"]);
    await state.callbacks.onMessage({
      app_id: "cli_test",
      sender: { sender_type: "user", sender_id: { open_id: "ou_user", union_id: "on_union" } },
      message: {
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
        chat_type: "p2p",
        chat_id: "oc_chat",
        create_time: String(Date.now()),
        message_id: "om_1",
      },
    });
    expect(inbound).toHaveLength(1);
    state.callbacks.onReconnecting();
    expect(await state.adapter.health()).toEqual(expect.objectContaining({ connection_state: "reconnecting", ready: false }));
    state.callbacks.onReconnected();
    expect(await state.adapter.health()).toEqual(expect.objectContaining({ connection_state: "connected", ready: true }));
    await Promise.all([state.adapter.stop(), state.adapter.stop()]);
    expect(state.calls).toEqual(["start", "stop:false"]);
  });

  test("startup failure cleans the SDK connection and bounded stop escalates to force", async () => {
    const failed = setup({ failStart: true });
    failed.adapter.setInboundSink(async () => undefined);
    await expect(failed.adapter.start()).rejects.toThrow("connect failed");
    expect(failed.calls).toEqual(["start", "stop:true"]);

    const hanging = setup({ hangStop: true });
    hanging.adapter.setInboundSink(async () => undefined);
    await hanging.adapter.start();
    await hanging.adapter.stop();
    expect(hanging.calls).toEqual(["start", "stop:false", "stop:true"]);
  });

  test("stop remains bounded when it races an SDK start that never settles", async () => {
    const state = setup({ hangStart: true });
    state.adapter.setInboundSink(async () => undefined);
    void state.adapter.start().catch(() => undefined);
    await Bun.sleep(0);
    const result = await Promise.race([
      state.adapter.stop().then(() => "stopped"),
      Bun.sleep(50).then(() => "timeout"),
    ]);
    expect(result).toBe("stopped");
    expect(state.calls).toContain("stop:true");
  });

  test("validates outbound shapes and delegates stream, card, typing and files", async () => {
    const state = setup();
    state.adapter.setInboundSink(async () => undefined);
    await state.adapter.start();
    await state.adapter.handleOutbound(outbound("send_message", { markdown: "**done**" }));
    await state.adapter.handleOutbound(outbound("typing_indicator", { operation: "start" }));
    await state.adapter.handleOutbound(outbound("stream_message", {
      stream_type: "final_answer",
      state: "delta",
      seq: 1,
      content: "hello",
      thinking: "",
      redacted_thinking_count: 0,
      thinking_elapsed_ms: 0,
      tool_pending: false,
      tool_elapsed_ms: 0,
      tool_steps: [],
    }));
    const root = await mkdtemp(join(tmpdir(), "lxe-adapter-"));
    roots.push(root);
    const file = join(root, "result.txt");
    await writeFile(file, "result");
    await state.adapter.handleOutbound(outbound("send_file", { path: file }));
    expect(state.apiCalls.some((item) => item.includes("/reply"))).toBe(true);
    await expect(state.adapter.handleOutbound(outbound("send_message", {}))).rejects.toThrow("empty");
    await expect(state.adapter.handleOutbound({ ...outbound("send_message", { markdown: "x" }), platform: "slack" })).rejects.toThrow("platform");
    await expect(state.adapter.handleOutbound(outbound("unknown", {}))).rejects.toThrow("unsupported");
    await state.adapter.stop();
  });

  test("dumps raw inbound events only when local logs are enabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "lxe-adapter-raw-"));
    roots.push(root);
    const state = setup({ projectRoot: root, rawDump: true });
    state.adapter.setInboundSink(async () => undefined);
    await state.adapter.start();
    await state.callbacks.onMessage({
      sender: { sender_type: "user", sender_id: { open_id: "ou_user" } },
      message: {
        message_type: "system", content: JSON.stringify({ text: "joined" }), chat_type: "p2p",
        chat_id: "oc_chat", create_time: String(Date.now()), message_id: "om_raw",
      },
    });
    const days = await readdir(join(root, "logs", "runtime"));
    const raw = await readFile(join(root, "logs", "runtime", days[0]!, "feishu_raw_events.jsonl"), "utf8");
    expect(raw).toContain("om_raw");
    expect(raw.trim().split(/\r?\n/)).toHaveLength(1);
    await state.adapter.stop();
  });
});
