import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { JsonObject } from "@lxe/protocol";
import { FeishuMedia } from "./media";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const route = (source = "om_source") => ({
  response_route_id: "route-1",
  platform_message_id: "",
  owner_user_id: "ou_user",
  conversation_id: "oc_chat",
  conversation_type: "2",
  sender_nick: "Tester",
  message_id: source,
  extra_data: source ? { source_message_id: source } : {},
});

describe("Feishu media and card delivery", () => {
  test("markdown and files reply to source message, while no-source routes target chat", async () => {
    const calls: Array<{ method: string; path: string; body: JsonObject }> = [];
    const api = {
      request: async (method: string, path: string, body: JsonObject) => {
        calls.push({ method, path, body });
        return { code: 0, data: { message_id: "om_sent" } };
      },
      upload: async (path: string, kind: "image" | "file") => `${kind}_${path.split("/").at(-1)}`,
    };
    const media = new FeishuMedia({ api });
    await media.sendMarkdown(route(), "**done**", "Result");
    const root = await mkdtemp(join(tmpdir(), "lxe-feishu-media-"));
    roots.push(root);
    const file = join(root, "report.txt");
    const image = join(root, "chart.png");
    await writeFile(file, "report");
    await writeFile(image, "png");
    await media.sendFile(route(), file);
    await media.sendFile(route(), image);
    await media.sendMarkdown(route(""), "chat message");

    expect(calls.slice(0, 3).map((item) => item.path)).toEqual([
      "/im/v1/messages/om_source/reply",
      "/im/v1/messages/om_source/reply",
      "/im/v1/messages/om_source/reply",
    ]);
    expect(calls[1]?.body.msg_type).toBe("file");
    expect(calls[2]?.body.msg_type).toBe("image");
    expect(calls[3]?.path).toBe("/im/v1/messages?receive_id_type=chat_id");
    expect(calls[3]?.body.receive_id).toBe("oc_chat");
  });

  test("rejects empty markdown, missing paths and nonzero API responses", async () => {
    const media = new FeishuMedia({
      api: {
        request: async () => ({ code: 999 }),
        upload: async () => "key",
      },
    });
    await expect(media.sendMarkdown(route(), " ")).rejects.toThrow("empty");
    await expect(media.sendFile(route(), "/definitely/missing")).rejects.toThrow("missing");
    await expect(media.sendMarkdown(route(), "content")).rejects.toThrow("999");
  });
});
