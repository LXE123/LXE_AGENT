import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { InboundEvent, JsonObject } from "@lxe/protocol";
import type { OutboundRequest } from "../../../src/state/models";
import { loadFeishuConfig } from "../../../src/channels/feishu/config";
import { FeishuAdapter } from "../../../src/channels/feishu/adapter";
import { buildFinalCard } from "../../../src/channels/feishu/card-builder";
import type { InboundImageProcessorPort } from "../../../src/channels/feishu/image-contract";
import type { FeishuSdkCallbacks, FeishuSdkServices } from "../../../src/channels/feishu/sdk";

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
  turn_id: "turn-1",
  response_route_id: "route-1",
  event_id: "emit-1",
});

const unusedImageProcessor: InboundImageProcessorPort = {
  process: async () => {
    throw new Error("unexpected image processing in adapter test");
  },
};
const passImageProcessor: InboundImageProcessorPort = {
  process: async (request) => ({
    bytes: request.bytes,
    savedPath: request.outputPath,
    modelBlock: {
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: "AQID" },
    },
    metadata: {
      ...request.resource,
      saved_path: request.outputPath,
      download_status: "success",
      processing_status: "success",
    },
  }),
};

const finalCard = (content: string): JsonObject => buildFinalCard({
  content,
  thinking: "",
  redactedCount: 0,
  thinkingElapsedMs: 0,
  toolPending: false,
  toolElapsedMs: 0,
  toolSteps: [],
  metrics: {
    status: "completed",
    elapsed_ms: 1_200,
    model: "test-model",
    input_tokens: 10,
    output_tokens: 5,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    context_tokens: 15,
    context_window_tokens: 200_000,
  },
}, loadFeishuConfig({}).cardDisplay);

interface SetupOptions {
  failStart?: boolean;
  hangStart?: boolean;
  hangStop?: boolean;
  projectRoot?: string;
  rawDump?: boolean;
  apiRequest?: FeishuSdkServices["api"]["request"];
  resourceDownload?: NonNullable<FeishuSdkServices["resources"]>["download"];
  imageProcessor?: InboundImageProcessorPort;
}

const setup = (options: SetupOptions = {}) => {
  let callbacks!: FeishuSdkCallbacks;
  const calls: string[] = [];
  const apiCalls: string[] = [];
  const apiRequests: Array<{
    method: string;
    path: string;
    options?: { body?: JsonObject; query?: JsonObject };
  }> = [];
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
      request: async (method, path, requestOptions) => {
        apiCalls.push(`${method}:${path}`);
        apiRequests.push({ method, path, ...(requestOptions ? { options: requestOptions } : {}) });
        if (options.apiRequest) return options.apiRequest(method, path, requestOptions);
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
    ...(options.resourceDownload ? { resources: { download: options.resourceDownload } } : {}),
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
    imageProcessor: options.imageProcessor ?? unusedImageProcessor,
    sdkFactory: (value) => { callbacks = value; return services; },
    stopTimeoutMs: 5,
    ...(options.projectRoot ? { projectRoot: options.projectRoot } : {}),
  });
  return { adapter, calls, apiCalls, apiRequests, get callbacks() { return callbacks; } };
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

  test("reads quoted cards from the single-message raw endpoint first", async () => {
    const parentId = "om_direct_quote";
    const state = setup({
      apiRequest: async (_method, path) => {
        if (path !== `/im/v1/messages/${parentId}`) throw new Error(`unexpected path: ${path}`);
        return { code: 0, data: { items: [{
          message_id: parentId,
          msg_type: "interactive",
          sender: { id: "cli_agent", name: "LXE_Claw" },
          body: { content: JSON.stringify({ json_card: JSON.stringify({
            schema: "2.0",
            body: { elements: [{ tag: "markdown", content: "direct quote body" }] },
          }) }) },
        }] } };
      },
    });
    const inbound: InboundEvent[] = [];
    state.adapter.setInboundSink(async (event) => { inbound.push(event); });
    await state.adapter.start();
    await state.callbacks.onMessage({
      sender: { sender_type: "user", sender_id: { open_id: "ou_user" } },
      message: {
        message_type: "text",
        content: JSON.stringify({ text: "read it" }),
        chat_type: "p2p",
        chat_id: "oc_chat",
        parent_id: parentId,
        create_time: String(Date.now()),
        message_id: "om_direct_reply",
      },
    });
    expect(inbound[0]?.user_input).toContain("direct quote body");
    expect(state.apiRequests).toEqual([{
      method: "GET",
      path: `/im/v1/messages/${parentId}`,
      options: { query: {
        user_id_type: "open_id",
        card_msg_content_type: "raw_card_content",
      } },
    }]);
    await state.adapter.stop();
  });

  test("falls back to mget for quoted cards without inventing image attachments", async () => {
    const root = await mkdtemp(join(tmpdir(), "lxe-adapter-card-quote-"));
    roots.push(root);
    let downloadCount = 0;
    const parentId = "om_x100b6a81234160a0b0386b979412c90";
    const state = setup({
      projectRoot: root,
      apiRequest: async (_method, path) => {
        if (path !== "/im/v1/messages/mget") throw new Error(`unexpected path: ${path}`);
        return { code: 0, data: { items: [{
          message_id: parentId,
          msg_type: "interactive",
          sender: { id: "cli_agent", name: "LXE_Claw" },
          body: { content: JSON.stringify({
            card_schema: 2,
            json_card: JSON.stringify({
              schema: "2.0",
              body: { elements: [{
                tag: "markdown",
                content: "我现在看到的 system prompt 里 skill 路径是：\n\n```text\n/Users/llxx/Projects/github/LXE_AGENT_LOCAL_FBA/skills\n```",
              }] },
            }),
          }) },
        }] } };
      },
      resourceDownload: async () => {
        downloadCount += 1;
        throw new Error("card resources must not be downloaded");
      },
    });
    const inbound: InboundEvent[] = [];
    state.adapter.setInboundSink(async (event) => { inbound.push(event); });
    await state.adapter.start();
    await state.callbacks.onMessage({
      sender: { sender_type: "user", sender_id: { open_id: "ou_user" } },
      message: {
        message_type: "text",
        content: JSON.stringify({ text: "我回复了一条消息，你能看到这个消息吗？" }),
        chat_type: "p2p",
        chat_id: "oc_chat",
        parent_id: parentId,
        create_time: String(Date.now()),
        message_id: "om_reply",
      },
    });
    const event = inbound[0];
    expect(event?.user_input).toContain("system prompt 里 skill 路径");
    expect(event?.user_input).toContain("/Users/llxx/Projects/github/LXE_AGENT_LOCAL_FBA/skills");
    expect(event?.user_input).not.toContain("[image]");
    expect(event?.user_input).not.toContain("请升级至最新版本客户端");
    expect(event?.user_input).not.toContain("Unable to download");
    expect(event?.user_content_blocks).toEqual([]);
    expect(event?.raw_data.resources).toEqual([]);
    expect(downloadCount).toBe(0);
    expect(state.apiRequests).toContainEqual({
      method: "GET",
      path: "/im/v1/messages/mget",
      options: { query: {
        message_ids: parentId,
        user_id_type: "open_id",
        card_msg_content_type: "raw_card_content",
      } },
    });
    await state.adapter.stop();
  });

  test("falls back to mget when direct lookup succeeds but card conversion fails", async () => {
    const parentId = "om_conversion_fallback";
    const state = setup({
      apiRequest: async (_method, path) => ({
        code: 0,
        data: { items: [{
          message_id: parentId,
          msg_type: "interactive",
          sender: { id: "cli_agent", name: "LXE_Claw" },
          body: { content: path === "/im/v1/messages/mget"
            ? JSON.stringify({
                card_schema: 2,
                json_card: JSON.stringify(finalCard("**Actual card body**\n\n```text\n/Users/example/skills\n```")),
              })
            : JSON.stringify({ json_card: "{invalid" }) },
        }] },
      }),
    });
    const inbound: InboundEvent[] = [];
    state.adapter.setInboundSink(async (event) => { inbound.push(event); });
    await state.adapter.start();
    await state.callbacks.onMessage({
      sender: { sender_type: "user", sender_id: { open_id: "ou_user" } },
      message: {
        message_type: "text",
        content: JSON.stringify({ text: "现在呢" }),
        chat_type: "p2p",
        chat_id: "oc_chat",
        parent_id: parentId,
        create_time: String(Date.now()),
        message_id: "om_conversion_reply",
      },
    });
    expect(inbound[0]?.user_input).toContain("Actual card body");
    expect(inbound[0]?.user_input).toContain("/Users/example/skills");
    expect(inbound[0]?.diagnostics).toEqual([]);
    expect(state.apiRequests.map((request) => request.path)).toEqual([
      `/im/v1/messages/${parentId}`,
      "/im/v1/messages/mget",
    ]);
    await state.adapter.stop();
  });

  test("reports unknown quote lookup failures without speculative causes or resources", async () => {
    const state = setup({
      apiRequest: async (_method, path) => {
        if (path === "/im/v1/messages/mget") {
          return { code: 999999, msg: "lookup failed token=private", log_id: "log-quote" };
        }
        throw Object.assign(new Error("Request failed with status code 400"), {
          response: { status: 400, data: { code: 200000, msg: "invalid request", log_id: "log-direct" } },
        });
      },
    });
    const inbound: InboundEvent[] = [];
    state.adapter.setInboundSink(async (event) => { inbound.push(event); });
    await state.adapter.start();
    await state.callbacks.onMessage({
      sender: { sender_type: "user", sender_id: { open_id: "ou_user" } },
      message: {
        message_type: "text",
        content: JSON.stringify({ text: "现在呢" }),
        chat_type: "p2p",
        chat_id: "oc_chat",
        parent_id: "om_missing_quote",
        create_time: String(Date.now()),
        message_id: "om_missing_reply",
      },
    });
    const event = inbound[0];
    expect(event?.user_input).toBe("现在呢");
    expect(event?.user_input).not.toContain("请升级至最新版本客户端");
    expect(event?.user_input).not.toContain("[image]");
    expect(event?.user_input).not.toContain("Unable to download");
    expect(event?.user_content_blocks).toEqual([]);
    expect(event?.raw_data.resources).toEqual([]);
    expect(event?.diagnostics).toEqual([
      expect.objectContaining({
        operation: "quoted_message_read",
        stage: "quote_lookup",
        observed_error: "invalid request",
        http_status: 400,
        provider_code: 200000,
        log_id: "log-direct",
        cause_known: false,
      }),
      expect.objectContaining({
        operation: "quoted_message_read",
        stage: "quote_lookup",
        observed_error: "Feishu get_messages failed with code 999999: lookup failed token=[redacted]",
        provider_code: 999999,
        log_id: "log-quote",
        redacted: true,
        cause_known: false,
      }),
    ]);
    expect(event?.raw_data.quoted_message).toMatchObject({
      message_id: "om_missing_quote",
      available: false,
      cause_known: false,
      failure_stages: ["quote_lookup"],
      observed_errors: ["invalid request", expect.stringContaining("lookup failed token=[redacted]")],
    });
    expect(state.apiRequests.map((request) => request.path)).toEqual([
      "/im/v1/messages/om_missing_quote",
      "/im/v1/messages/mget",
    ]);
    await state.adapter.stop();
  });

  test("fetches raw content for direct and merged interactive messages", async () => {
    const state = setup({
      apiRequest: async (_method, path) => {
        if (path === "/im/v1/messages/om_direct") {
          return { code: 0, data: { items: [{
            message_id: "om_direct",
            body: { content: JSON.stringify({ json_card: JSON.stringify({
              schema: "2.0",
              body: { elements: [{ tag: "markdown", content: "direct raw card" }] },
            }) }) },
          }] } };
        }
        if (path === "/im/v1/messages/om_forward") {
          return { code: 0, data: { items: [{
            message_id: "om_child",
            upper_message_id: "om_forward",
            msg_type: "interactive",
            sender: { id: "ou_author", name: "Author" },
            body: { content: JSON.stringify({ json_card: JSON.stringify({
              schema: "2.0",
              body: { elements: [{ tag: "markdown", content: "forwarded raw card" }] },
            }) }) },
          }] } };
        }
        throw new Error(`unexpected path: ${path}`);
      },
    });
    const inbound: InboundEvent[] = [];
    state.adapter.setInboundSink(async (event) => { inbound.push(event); });
    await state.adapter.start();
    await state.callbacks.onMessage({
      sender: { sender_type: "user", sender_id: { open_id: "ou_user" } },
      message: {
        message_type: "interactive",
        content: JSON.stringify({ body: { elements: [
          { tag: "img", image_key: "img_v3_internal" },
          { tag: "fallback_text", text: { content: "请升级至最新版本客户端，以查看内容" } },
        ] } }),
        chat_type: "p2p",
        chat_id: "oc_chat",
        create_time: String(Date.now()),
        message_id: "om_direct",
      },
    });
    await state.callbacks.onMessage({
      sender: { sender_type: "user", sender_id: { open_id: "ou_user" } },
      message: {
        message_type: "merge_forward",
        content: JSON.stringify({ title: "Forwarded" }),
        chat_type: "p2p",
        chat_id: "oc_chat",
        create_time: String(Date.now()),
        message_id: "om_forward",
      },
    });
    expect(inbound[0]?.user_input).toContain("direct raw card");
    expect(inbound[0]?.user_input).not.toContain("img_v3_internal");
    expect(inbound[0]?.raw_data.resources).toEqual([]);
    expect(inbound[1]?.user_input).toContain("forwarded raw card");
    for (const messageId of ["om_direct", "om_forward"]) {
      expect(state.apiRequests).toContainEqual({
        method: "GET",
        path: `/im/v1/messages/${messageId}`,
        options: { query: {
          user_id_type: "open_id",
          card_msg_content_type: "raw_card_content",
        } },
      });
    }
    await state.adapter.stop();
  });

  test("keeps ordinary quoted images multimodal and degrades raw-card lookup failures to event text", async () => {
    const root = await mkdtemp(join(tmpdir(), "lxe-adapter-image-quote-"));
    roots.push(root);
    const downloads: Array<[string, string, string]> = [];
    const state = setup({
      projectRoot: root,
      imageProcessor: passImageProcessor,
      apiRequest: async (_method, path) => {
        if (path === "/im/v1/messages/mget") {
          return { code: 0, data: { items: [{
            message_id: "om_image_parent",
            msg_type: "image",
            sender: { id: "ou_author", name: "Author" },
            body: { content: JSON.stringify({ image_key: "img_real" }) },
          }] } };
        }
        if (path === "/im/v1/messages/om_failed_card") throw new Error("raw card unavailable");
        throw new Error(`unexpected path: ${path}`);
      },
      resourceDownload: async (messageId, fileKey, type) => {
        downloads.push([messageId, fileKey, type]);
        return { data: new Uint8Array([1, 2, 3]), contentType: "image/jpeg", fileName: "quoted.jpg" };
      },
    });
    const inbound: InboundEvent[] = [];
    state.adapter.setInboundSink(async (event) => { inbound.push(event); });
    await state.adapter.start();
    await state.callbacks.onMessage({
      sender: { sender_type: "user", sender_id: { open_id: "ou_user" } },
      message: {
        message_type: "text",
        content: JSON.stringify({ text: "what is this?" }),
        chat_type: "p2p",
        chat_id: "oc_chat",
        parent_id: "om_image_parent",
        create_time: String(Date.now()),
        message_id: "om_image_reply",
      },
    });
    await state.callbacks.onMessage({
      sender: { sender_type: "user", sender_id: { open_id: "ou_user" } },
      message: {
        message_type: "interactive",
        content: JSON.stringify({ body: { elements: [{ tag: "markdown", content: "event fallback card" }] } }),
        chat_type: "p2p",
        chat_id: "oc_chat",
        create_time: String(Date.now()),
        message_id: "om_failed_card",
      },
    });
    expect(downloads).toEqual([["om_image_parent", "img_real", "image"]]);
    expect(inbound[0]?.user_content_blocks).toEqual([
      { type: "text", text: expect.stringContaining("what is this?") },
      expect.objectContaining({ type: "image" }),
    ]);
    expect(inbound[0]?.raw_data.resources).toEqual([
      expect.objectContaining({ file_key: "img_real", quoted: true, download_status: "success" }),
    ]);
    expect(inbound[1]?.user_input).toContain("event fallback card");
    expect(inbound[1]?.raw_data.resources).toEqual([]);
    await state.adapter.stop();
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
    const days = await readdir(join(root, "var", "logs", "feishu_raw_events"));
    const raw = await readFile(join(root, "var", "logs", "feishu_raw_events", days[0]!), "utf8");
    expect(raw).toContain("om_raw");
    expect(raw.trim().split(/\r?\n/)).toHaveLength(1);
    await state.adapter.stop();
  });

  test("contains inbound normalization or sink failures and exposes them through health", async () => {
    const state = setup();
    state.adapter.setInboundSink(async () => { throw new Error("sink offline"); });
    await state.adapter.start();
    await expect(state.callbacks.onMessage({
      sender: { sender_type: "user", sender_id: { open_id: "ou_user" } },
      message: {
        message_type: "text", content: JSON.stringify({ text: "hello" }), chat_type: "p2p",
        chat_id: "oc_chat", create_time: String(Date.now()), message_id: "om_failed",
      },
    })).resolves.toBeUndefined();
    expect(await state.adapter.health()).toEqual(expect.objectContaining({ last_error: "sink offline" }));
    await state.adapter.stop();
  });
});
