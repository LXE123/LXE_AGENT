import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry } from "@lxe/runtime";
import { registerFeishuImTools, type FeishuImToolApi } from "../../../src/channels/feishu/tools";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const context = () => ({
  session_id: "session-1",
  handle: {
    signal: new AbortController().signal,
    cancelled: false,
    drainSteering: () => [],
    registerProcess: () => () => undefined,
  },
});

describe("native Feishu IM tools", () => {
  test("read the current chat and download resources through the Bun API client", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-feishu-tools-"));
    roots.push(root);
    const calls: Array<{ path: string; params: Record<string, string> }> = [];
    const api: FeishuImToolApi = {
      get: async (path, params) => {
        calls.push({ path, params });
        return {
          items: [{ message_id: "om_1", msg_type: "text", body: { content: "{\"text\":\"你好\"}" }, sender: { id: "ou_1" } }],
          has_more: false,
        };
      },
      download: async () => ({ data: new Uint8Array([1, 2, 3]), contentType: "image/png", fileName: "a.png" }),
    };
    const registry = new ToolRegistry();
    registerFeishuImTools(registry, {
      api,
      workspaceRoot: root,
      sessionSource: async () => ({ platform: "feishu", chat_id: "oc_current" }),
    });

    const messages = await registry.execute("feishu_im_bot_get_messages", { page_size: 20 }, context());
    expect(JSON.parse(String(messages.content[0]?.text))).toMatchObject({
      chat_id: "oc_current", messages: [{ message_id: "om_1", content: "你好" }],
    });
    expect(calls[0]).toMatchObject({ path: "/im/v1/messages", params: { container_id: "oc_current", page_size: "20" } });

    const resource = await registry.execute("feishu_im_bot_fetch_resource", {
      message_id: "om_1", file_key: "img_1", type: "image",
    }, context());
    const payload = JSON.parse(String(resource.content[0]?.text));
    expect(readFileSync(payload.saved_path)).toEqual(Buffer.from([1, 2, 3]));
    expect(resource.files).toEqual([payload.saved_path]);
  });
});
