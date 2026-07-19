import { describe, expect, test } from "bun:test";
import { FEISHU_CONVERTER_TYPES, FeishuInboundNormalizer, convertFeishuMessage, snapshotMessageEvent } from "../../../src/channels/feishu/inbound";

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
    diagnostics: [],
  }),
});

const normalizeEvent = async (
  instance: FeishuInboundNormalizer,
  snapshot: Parameters<FeishuInboundNormalizer["normalize"]>[0],
) => {
  const decision = await instance.normalize(snapshot);
  return decision.accepted ? decision.event : null;
};

describe("Feishu inbound normalization", () => {
  test("snapshots p2p identity, thread, quote and union fields", async () => {
    const snapshot = snapshotMessageEvent(baseEvent());
    expect(snapshot).not.toBeNull();
    const event = await normalizeEvent(normalizer(), snapshot!);
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
      diagnostics: [],
    });
  });

  test("requires and strips the bot mention in groups", async () => {
    const withoutMention = snapshotMessageEvent(baseEvent({ chat_type: "group", message_id: "om_2" }))!;
    expect(await normalizeEvent(normalizer(), withoutMention)).toBeNull();

    const withMention = snapshotMessageEvent(baseEvent({
      chat_type: "group",
      message_id: "om_3",
      content: JSON.stringify({ text: "@_user_1 restock now" }),
      mentions: [{ key: "@_user_1", name: "LXE", id: { open_id: "ou_bot" } }],
    }))!;
    const event = await normalizeEvent(normalizer(), withMention);
    expect(event?.is_group).toBe(true);
    expect(event?.user_input).toBe("restock now");
  });

  test("injects quoted content and resource metadata produced by the shared converter path", async () => {
    const instance = new FeishuInboundNormalizer({
      nowMs: () => 1_000_000,
      monotonicMs: () => 100,
      uuid: () => "route-quote",
      loadQuote: async () => ({
        text: "[Replying to message_id=om_parent]\nAlice: quoted image",
        metadata: { message_id: "om_parent", message_type: "image", available: true },
        userContentBlocks: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "abc" } }],
        resourceMetadata: [{ type: "image", file_key: "img-parent", saved_path: "/tmp/parent.jpg" }],
      }),
    });
    const event = await normalizeEvent(instance, snapshotMessageEvent(baseEvent({ message_id: "om_quote" }))!);
    expect(event?.user_input).toContain("Alice: quoted image");
    expect(event?.user_content_blocks[0]).toMatchObject({ type: "text", text: expect.stringContaining("quoted image") });
    expect(event?.user_content_blocks[1]).toMatchObject({ type: "image" });
    expect(event?.raw_data.quoted_message).toMatchObject({ message_type: "image", available: true });
    expect(event?.raw_data.resources).toEqual([
      { type: "image", file_key: "img-parent", saved_path: "/tmp/parent.jpg", quoted: true },
    ]);
  });

  test("normalizes post text and image/file resources", async () => {
    const post = snapshotMessageEvent(baseEvent({
      message_id: "om_post",
      message_type: "post",
      content: JSON.stringify({ zh_cn: { title: "Report", content: [[{ tag: "text", text: "Ready" }]] } }),
    }))!;
    expect((await normalizeEvent(normalizer(), post))?.user_input).toBe("**Report**\n\nReady");

    const image = snapshotMessageEvent(baseEvent({
      message_id: "om_image",
      message_type: "image",
      content: JSON.stringify({ image_key: "img_1" }),
    }))!;
    const imageEvent = await normalizeEvent(normalizer(), image);
    expect(imageEvent?.user_content_blocks).toEqual([
      { type: "text", text: "[image:img_1]" },
      { type: "image", file_key: "img_1" },
    ]);
    expect(imageEvent?.raw_data.resources).toEqual([{ type: "image", file_key: "img_1", file_name: "", message_id: "om_image" }]);

    const file = snapshotMessageEvent(baseEvent({
      message_id: "om_file",
      message_type: "file",
      content: JSON.stringify({ file_key: "file_1", file_name: "补货.xlsx" }),
    }))!;
    expect((await normalizeEvent(normalizer(), file))?.user_content_blocks).toEqual([
      { type: "text", text: "[file:补货.xlsx]" },
      { type: "file", file_key: "file_1" },
    ]);
  });

  test("preserves rich post Markdown, mentions, images and media resources", async () => {
    const snapshot = snapshotMessageEvent(baseEvent({
      message_id: "om_rich",
      message_type: "post",
      mentions: [{ key: "@_user_2", name: "Alice", id: { open_id: "ou_alice" } }],
      content: JSON.stringify({ zh_cn: {
        title: "Status",
        content: [[
          { tag: "text", text: "Ready", style: ["bold", "italic"] },
          { tag: "a", text: " docs", href: "https://example.test/docs" },
          { tag: "at", user_id: "ou_alice" },
          { tag: "img", image_key: "img-inline" },
          { tag: "media", file_key: "file-inline", file_name: "补货 表.xlsx" },
        ]],
      } }),
    }))!;
    const converted = await convertFeishuMessage(snapshot);
    expect(converted.message).toContain("***Ready***");
    expect(converted.message).toContain("[docs](https://example.test/docs)");
    expect(converted.message).toContain("@_user_2");
    expect(converted.resources).toEqual([
      { type: "image", file_key: "img-inline", file_name: "", message_id: "om_rich" },
      { type: "file", file_key: "file-inline", file_name: "补货 表.xlsx", message_id: "om_rich" },
    ]);
    const event = await normalizeEvent(normalizer(), snapshot);
    expect(event?.user_content_blocks[0]).toMatchObject({ type: "text", text: expect.stringContaining("Ready") });
    expect(event?.user_content_blocks[1]).toMatchObject({ type: "image", file_key: "img-inline" });
  });

  test("expands merged forwards through the API while retaining hierarchy, sender and resources", async () => {
    const snapshot = snapshotMessageEvent(baseEvent({
      message_id: "om_forward",
      message_type: "merge_forward",
      content: JSON.stringify({ title: "History" }),
    }))!;
    const converted = await convertFeishuMessage(snapshot, {
      fetchSubMessages: async () => [
        {
          message_id: "om_child",
          upper_message_id: "om_forward",
          msg_type: "text",
          create_time: "1700000000000",
          sender: { id: "ou_alice", sender_type: "user" },
          body: { content: JSON.stringify({ text: "first" }) },
        },
        {
          message_id: "om_nested",
          upper_message_id: "om_child",
          msg_type: "image",
          create_time: "1700000001000",
          sender: { id: "ou_bob", sender_type: "user" },
          body: { content: JSON.stringify({ image_key: "img-nested" }) },
        },
      ],
      resolveUserName: (id) => ({ ou_alice: "Alice", ou_bob: "Bob" })[id],
    });
    expect(converted.message).toContain("<forwarded_messages title=\"History\">");
    expect(converted.message).toContain("Alice:");
    expect(converted.message).toContain("first");
    expect(converted.message).toContain("Bob:");
    expect(converted.resources).toEqual([
      { type: "image", file_key: "img-nested", file_name: "", message_id: "om_nested" },
    ]);
  });

  test("recursively extracts interactive headers, columns and actions", async () => {
    const snapshot = snapshotMessageEvent(baseEvent({
      message_id: "om_card",
      message_type: "interactive",
      content: JSON.stringify({
        header: { title: { tag: "plain_text", content: "Inventory alert" }, subtitle: { content: "Shenzhen" } },
        body: { elements: [
          { tag: "column_set", columns: [{ tag: "column", elements: [{ tag: "markdown", content: "**Low stock**" }] }] },
          { tag: "actions", actions: [{ tag: "button", text: { content: "Open report" } }] },
        ] },
      }),
    }))!;
    const converted = await convertFeishuMessage(snapshot);
    expect(converted.message).toContain("Inventory alert");
    expect(converted.message).toContain("Shenzhen");
    expect(converted.message).toContain("**Low stock**");
    expect(converted.message).toContain("[button] Open report");
    expect(converted.resources).toEqual([]);
  });

  test("converts raw CardKit content without treating card internals as message resources", async () => {
    const snapshot = snapshotMessageEvent(baseEvent({
      message_id: "om_raw_card",
      message_type: "interactive",
      content: JSON.stringify({
        card_schema: 2,
        json_attachment: JSON.stringify({ images: { internal: "img_private" } }),
        json_card: JSON.stringify({
          schema: "2.0",
          header: { property: { title: { tag: "plain_text", property: { content: "Path report" } } } },
          body: { property: { elements: [
            { tag: "markdown", property: { content: "**Absolute path**\n\n```text\n/Users/example/skills\n```" } },
            {
              tag: "collapsible_panel",
              property: {
                header: { title: { tag: "plain_text", property: { content: "Tool steps" } } },
                elements: [{ tag: "div", property: { text: { tag: "plain_text", property: { content: "read succeeded" } } } }],
              },
            },
            { tag: "img", property: { imageID: "img_v3_internal", alt: { content: "Architecture" } } },
            { tag: "custom_icon", property: { imgKey: "img_v3_loading" } },
            { tag: "fallback_text", property: { text: { content: "请升级至最新版本客户端，以查看内容" } } },
          ] } },
          footer: { tag: "markdown", property: { content: "Completed · 1.2s" } },
        }),
      }),
    }))!;
    const converted = await convertFeishuMessage(snapshot);
    expect(converted.message).toContain("Path report");
    expect(converted.message).toContain("/Users/example/skills");
    expect(converted.message).toContain("Tool steps");
    expect(converted.message).toContain("read succeeded");
    expect(converted.message).toContain("Completed · 1.2s");
    expect(converted.message).toContain("[Card image: Architecture]");
    expect(converted.message).not.toContain("img_v3");
    expect(converted.message).not.toContain("请升级至最新版本客户端");
    expect(converted.resources).toEqual([]);
  });

  test("drops legacy card fallback images and safely rejects malformed raw cards", async () => {
    const degraded = snapshotMessageEvent(baseEvent({
      message_id: "om_degraded_card",
      message_type: "interactive",
      content: JSON.stringify({ body: { elements: [
        { tag: "img", image_key: "img_v3_not_a_message_attachment" },
        { tag: "fallback_text", text: { content: "请升级至最新版本客户端，以查看内容" } },
      ] } }),
    }))!;
    const degradedResult = await convertFeishuMessage(degraded);
    expect(degradedResult.message).toBe("");
    expect(degradedResult.resources).toEqual([]);
    expect(degradedResult.diagnostics).toEqual([
      expect.objectContaining({
        stage: "card_convert",
        observed_error: "Feishu interactive card contains no readable text",
        cause_known: true,
        verified_reason: "interactive_card_has_no_readable_text",
      }),
    ]);

    const malformed = snapshotMessageEvent(baseEvent({
      message_id: "om_malformed_card",
      message_type: "interactive",
      content: JSON.stringify({ json_card: "{invalid", json_attachment: "img_v3_secret" }),
    }))!;
    const malformedResult = await convertFeishuMessage(malformed);
    expect(malformedResult.message).toBe("");
    expect(malformedResult.resources).toEqual([]);
    expect(malformedResult.diagnostics).toEqual([
      expect.objectContaining({
        stage: "raw_card_parse",
        error_name: "SyntaxError",
        observed_error: expect.stringContaining("Failed to parse Feishu raw card JSON"),
      }),
    ]);
    expect(JSON.stringify(malformedResult)).not.toContain("img_v3_secret");
  });

  test("converts the complete rich-message registry and preserves unknown messages", async () => {
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
      const converted = await convertFeishuMessage(snapshot);
      expect(converted.message || converted.resources.length > 0 || converted.diagnostics.length > 0).toBeTruthy();
    }
    expect(FEISHU_CONVERTER_TYPES).toEqual(expect.arrayContaining(Object.keys(fixtures)));
    const unknown = snapshotMessageEvent(baseEvent({
      message_id: "om_unknown", message_type: "future_type", content: JSON.stringify({ text: "future payload" }),
    }))!;
    expect((await convertFeishuMessage(unknown)).message).toContain("Unsupported Feishu message: future_type");
    expect((await convertFeishuMessage(unknown)).message).toContain("future payload");
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
    expect(await normalizeEvent(instance, fresh)).not.toBeNull();
    expect(await normalizeEvent(instance, fresh)).toBeNull();
    mono = 12 * 60 * 60 * 1000 + 1;
    expect(await normalizeEvent(instance, fresh)).not.toBeNull();

    const stale = snapshotMessageEvent(baseEvent({ message_id: "om_stale", create_time: "699999" }))!;
    expect(await normalizeEvent(instance, stale)).toBeNull();
  });

  test("accepts invalid/missing timestamps but rejects missing sender open id", async () => {
    expect(await normalizeEvent(normalizer(), snapshotMessageEvent(baseEvent({ message_id: "om_bad", create_time: "bad" }))!)).not.toBeNull();
    expect(await normalizeEvent(normalizer(), snapshotMessageEvent(baseEvent({ message_id: "om_none", create_time: "" }))!)).not.toBeNull();
    const missing = baseEvent({ message_id: "om_missing" });
    (missing.event.sender.sender_id as Record<string, string>).open_id = "";
    expect(await normalizeEvent(normalizer(), snapshotMessageEvent(missing)!)).toBeNull();
  });

  test("returns stable rejection reasons instead of an unexplained null", async () => {
    const duplicateNormalizer = normalizer();
    const duplicate = snapshotMessageEvent(baseEvent({ message_id: "om_reason_duplicate" }))!;
    expect((await duplicateNormalizer.normalize(duplicate)).accepted).toBe(true);
    expect(await duplicateNormalizer.normalize(duplicate)).toMatchObject({ accepted: false, reason: "duplicate" });

    expect(await normalizer().normalize(snapshotMessageEvent(baseEvent({
      message_id: "om_reason_stale", create_time: "699999",
    }))!)).toMatchObject({ accepted: false, reason: "stale" });

    const noIdentity = new FeishuInboundNormalizer({ nowMs: () => 1_000_000, monotonicMs: () => 100 });
    expect(await noIdentity.normalize(snapshotMessageEvent(baseEvent({
      message_id: "om_reason_identity", chat_type: "group",
    }))!)).toMatchObject({ accepted: false, reason: "group_bot_identity_missing" });

    expect(await normalizer().normalize(snapshotMessageEvent(baseEvent({
      message_id: "om_reason_mention", chat_type: "group",
    }))!)).toMatchObject({ accepted: false, reason: "group_without_bot_mention" });

    const missingSender = baseEvent({ message_id: "om_reason_sender" });
    (missingSender.event.sender.sender_id as Record<string, string>).open_id = "";
    expect(await normalizer().normalize(snapshotMessageEvent(missingSender)!)).toMatchObject({
      accepted: false, reason: "missing_sender_open_id",
    });

    expect(await normalizer().normalize(snapshotMessageEvent(baseEvent({
      message_id: "om_reason_empty", content: JSON.stringify({ text: "" }),
    }))!)).toMatchObject({ accepted: false, reason: "empty_content" });
  });
});
