import { describe, expect, test } from "bun:test";
import { FEISHU_CONVERTER_TYPES, FeishuInboundNormalizer, convertFeishuMessage, snapshotMessageEvent } from "./inbound";

const baseEvent = (patch: Record<string, unknown> = {}) => ({
  header: { app_id: "cli_test" },
  event: {
    sender: {
      sender_type: "user",
      sender_id: { open_id: "ou_user", user_id: "u_user", union_id: "on_union" },
    },
    message: {
      message_type: "text",
      content: JSON.stringify({ text: "hello" }),
      chat_type: "p2p",
      chat_id: "oc_chat",
      thread_id: "omt_thread",
      root_id: "om_root",
      parent_id: "om_parent",
      create_time: "1000000",
      update_time: "1000001",
      message_id: "om_1",
      mentions: [],
      ...patch,
    },
  },
});

const normalizer = () => new FeishuInboundNormalizer({
  botOpenId: "ou_bot",
  botName: "LXE",
  appId: "cli_test",
  nowMs: () => 1_000_000,
  monotonicMs: () => 100,
  uuid: () => "route-1",
  resolveResources: async (resources) => ({
    userInput: resources.map((item) => `[${item.type}:${item.file_name || item.file_key}]`).join("\n"),
    userContentBlocks: resources.map((item) => ({ type: item.type, file_key: item.file_key })),
    resourceMetadata: resources.map((item) => ({ ...item })),
  }),
});

describe("Feishu inbound normalization", () => {
  test("snapshots p2p identity, thread, quote and union fields", async () => {
    const snapshot = snapshotMessageEvent(baseEvent());
    expect(snapshot).not.toBeNull();
    const event = await normalizer().normalize(snapshot!);
    expect(event).toEqual({
      platform: "feishu",
      event_type: "agent_message",
      user_input: "hello",
      user_id: "ou_user",
      response_route_id: "route-1",
      conversation_id: "oc_chat",
      is_group: false,
      message_id: "om_1",
      sender_nick: "u_user",
      union_id: "on_union",
      source: {
        platform: "feishu",
        chat_id: "oc_chat",
        chat_type: "p2p",
        user_id: "ou_user",
        user_id_alt: "on_union",
        user_name: "u_user",
        thread_id: "omt_thread",
        message_id: "om_1",
        root_id: "om_root",
        parent_id: "om_parent",
        extra: {
          bot_app_id: "cli_test",
          bot_id: "ou_bot",
          bot_name: "LXE",
          bot_id_source: "configured",
          message_type: "text",
          sender_type: "user",
        },
      },
      raw_data: expect.objectContaining({
        platform: "feishu",
        app_id: "cli_test",
        union_id: "on_union",
        thread_id: "omt_thread",
        root_id: "om_root",
        parent_id: "om_parent",
        resources: [],
      }),
      user_content_blocks: [],
    });
  });

  test("requires and strips the bot mention in groups", async () => {
    const withoutMention = snapshotMessageEvent(baseEvent({ chat_type: "group", message_id: "om_2" }))!;
    expect(await normalizer().normalize(withoutMention)).toBeNull();

    const withMention = snapshotMessageEvent(baseEvent({
      chat_type: "group",
      message_id: "om_3",
      content: JSON.stringify({ text: "@_user_1 restock now" }),
      mentions: [{ key: "@_user_1", name: "LXE", id: { open_id: "ou_bot" } }],
    }))!;
    const event = await normalizer().normalize(withMention);
    expect(event?.is_group).toBe(true);
    expect(event?.user_input).toBe("restock now");
  });

  test("normalizes post text and image/file resources", async () => {
    const post = snapshotMessageEvent(baseEvent({
      message_id: "om_post",
      message_type: "post",
      content: JSON.stringify({ zh_cn: { title: "Report", content: [[{ tag: "text", text: "Ready" }]] } }),
    }))!;
    expect((await normalizer().normalize(post))?.user_input).toBe("Report\nReady");

    const image = snapshotMessageEvent(baseEvent({
      message_id: "om_image",
      message_type: "image",
      content: JSON.stringify({ image_key: "img_1" }),
    }))!;
    const imageEvent = await normalizer().normalize(image);
    expect(imageEvent?.user_content_blocks).toEqual([{ type: "image", file_key: "img_1" }]);
    expect(imageEvent?.raw_data.resources).toEqual([{ type: "image", file_key: "img_1", file_name: "" }]);

    const file = snapshotMessageEvent(baseEvent({
      message_id: "om_file",
      message_type: "file",
      content: JSON.stringify({ file_key: "file_1", file_name: "补货.xlsx" }),
    }))!;
    expect((await normalizer().normalize(file))?.user_content_blocks).toEqual([
      { type: "file", file_key: "file_1" },
    ]);
  });

  test("converts the complete rich-message registry and preserves unknown messages", () => {
    const fixtures: Record<string, Record<string, unknown>> = {
      location: { name: "Warehouse", address: "Shenzhen", latitude: "22.5", longitude: "114.0" },
      sticker: { file_key: "sticker-1" },
      calendar: { summary: "Planning", start_time: "10:00", event_id: "event-1" },
      share_chat: { chat_name: "Ops", chat_id: "chat-1" },
      share_user: { user_name: "Alice", user_id: "user-1" },
      share: { title: "Shared item" },
      folder: { file_key: "folder-1", file_name: "Reports" },
      todo: { summary: "Restock", due_time: "tomorrow", task_id: "task-1" },
      vote: { topic: "Ship today?", options: ["yes", "no"] },
      video_chat: { topic: "Daily", meeting_id: "meeting-1" },
      merge_forward: { title: "History", messages: [{ message_type: "text", content: JSON.stringify({ text: "nested" }) }] },
      interactive: { title: "Card title", text: "Card body" },
      system: { text: "User joined" },
    };
    for (const [messageType, content] of Object.entries(fixtures)) {
      const snapshot = snapshotMessageEvent(baseEvent({
        message_id: `om_${messageType}`,
        message_type: messageType,
        content: JSON.stringify(content),
      }))!;
      const converted = convertFeishuMessage(snapshot);
      expect(converted.message || converted.resources.length > 0).toBeTruthy();
    }
    expect(FEISHU_CONVERTER_TYPES).toEqual(expect.arrayContaining(Object.keys(fixtures)));
    const unknown = snapshotMessageEvent(baseEvent({
      message_id: "om_unknown", message_type: "future_type", content: JSON.stringify({ text: "future payload" }),
    }))!;
    expect(convertFeishuMessage(unknown).message).toContain("Unsupported Feishu message: future_type");
    expect(convertFeishuMessage(unknown).message).toContain("future payload");
  });

  test("deduplicates for 12 hours and rejects messages older than five minutes", async () => {
    let mono = 0;
    const instance = new FeishuInboundNormalizer({
      botOpenId: "ou_bot",
      nowMs: () => 1_000_000,
      monotonicMs: () => mono,
      uuid: () => "route",
    });
    const fresh = snapshotMessageEvent(baseEvent({ message_id: "om_dedupe" }))!;
    expect(await instance.normalize(fresh)).not.toBeNull();
    expect(await instance.normalize(fresh)).toBeNull();
    mono = 12 * 60 * 60 * 1000 + 1;
    expect(await instance.normalize(fresh)).not.toBeNull();

    const stale = snapshotMessageEvent(baseEvent({ message_id: "om_stale", create_time: "699999" }))!;
    expect(await instance.normalize(stale)).toBeNull();
  });

  test("accepts invalid/missing timestamps but rejects missing sender open id", async () => {
    expect(await normalizer().normalize(snapshotMessageEvent(baseEvent({ message_id: "om_bad", create_time: "bad" }))!)).not.toBeNull();
    expect(await normalizer().normalize(snapshotMessageEvent(baseEvent({ message_id: "om_none", create_time: "" }))!)).not.toBeNull();
    const missing = baseEvent({ message_id: "om_missing" });
    (missing.event.sender.sender_id as Record<string, string>).open_id = "";
    expect(await normalizer().normalize(snapshotMessageEvent(missing)!)).toBeNull();
  });
});
