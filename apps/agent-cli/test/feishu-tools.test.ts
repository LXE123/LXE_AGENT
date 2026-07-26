import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolExecutionError, ToolRegistry } from "@lxe/runtime";
import { loadAgentFeishuConfig } from "../src/feishu-runtime-config";
import {
  registerConfiguredFeishuImTools,
  registerFeishuImTools,
  normalizeFeishuToolError,
  type FeishuImToolApi,
} from "../src/feishu-tools";

const workspaceFor = (root: string) => ({ directory: root, worktree: root });

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const context = (root: string) => ({
  session_id: "session-1",
  workspace: workspaceFor(root),
  handle: {
    signal: new AbortController().signal,
    cancelled: false,
    drainSteering: () => [],
    registerProcess: () => () => undefined,
  },
});

describe("native Feishu IM tools", () => {
  test("does not register tools or construct an SDK client without inherited credentials", () => {
    const registry = new ToolRegistry();
    let clientCreated = false;

    const registered = registerConfiguredFeishuImTools(
      registry,
      loadAgentFeishuConfig({}),
      {
        sessionSource: async () => undefined,
        createApi: () => {
          clientCreated = true;
          throw new Error("must not construct Feishu client");
        },
      },
    );

    expect(registered).toBe(false);
    expect(clientCreated).toBe(false);
    expect(registry.definitionsSnapshot().filter((tool) => tool.name.startsWith("feishu_"))).toEqual([]);
  });

  test("read the current chat and download resources through the Bun API client", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-feishu-tools-"));
    roots.push(root);
    const calls: Array<{ path: string; params: Record<string, string> }> = [];
    const api: FeishuImToolApi = {
      get: async (path, params) => {
        calls.push({ path, params });
        if (path === "/im/v1/messages/om_1") {
          return {
            items: [{ message_id: "om_1", msg_type: "image", body: { content: "{\"image_key\":\"img_1\"}" } }],
          };
        }
        return {
          items: [{
            message_id: "om_1",
            msg_type: "text",
            body: { content: "{\"text\":\"你好 @_user_1\"}" },
            sender: {
              id: "on_sender",
              id_type: "union_id",
              sender_type: "user",
              sender_name: "Alice",
            },
            mentions: [{ key: "@_user_1", id: "u_bob", id_type: "user_id", name: "Bob" }],
          }],
          has_more: false,
        };
      },
      download: async () => ({ data: new Uint8Array([1, 2, 3]), contentType: "image/png", fileName: "a.png" }),
    };
    const registry = new ToolRegistry();
    registerFeishuImTools(registry, {
      api,
      sessionSource: async () => ({ platform: "feishu", chat_id: "oc_current" }),
    });

    const messages = await registry.execute("feishu_im_bot_get_messages", { page_size: 20 }, context(root));
    expect(JSON.parse(String(messages.content[0]?.text))).toMatchObject({
      chat_id: "oc_current",
      messages: [{
        message_id: "om_1",
        content: "你好 @Bob",
        sender: {
          id: "on_sender",
          id_type: "union_id",
          name: "Alice",
          union_id: "on_sender",
        },
        mentions: [{ id: "u_bob", id_type: "user_id", name: "Bob", user_id: "u_bob" }],
      }],
    });
    expect(JSON.parse(String(messages.content[0]?.text)).messages[0].sender).not.toHaveProperty("open_id");
    expect(calls[0]).toMatchObject({ path: "/im/v1/messages", params: { container_id: "oc_current", page_size: "20" } });

    const resource = await registry.execute("feishu_im_bot_fetch_resource", {
      message_id: "om_1", file_key: "img_1", type: "image",
    }, context(root));
    const payload = JSON.parse(String(resource.content[0]?.text));
    expect(readFileSync(payload.saved_path)).toEqual(Buffer.from([1, 2, 3]));
    expect(resource.files).toEqual([payload.saved_path]);
    expect(calls[1]).toEqual({
      path: "/im/v1/messages/om_1",
      params: { user_id_type: "open_id", card_msg_content_type: "raw_card_content" },
    });
  });

  test("returns only real group-list fields without fetching per-group details", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-feishu-groups-"));
    roots.push(root);
    const calls: Array<{ path: string; params: Record<string, string> }> = [];
    const registry = new ToolRegistry();
    registerFeishuImTools(registry, {
      api: {
        get: async (path, params) => {
          calls.push({ path, params });
          return {
            items: [{
              chat_id: "oc_ops",
              avatar: "https://example.test/avatar.png",
              name: "Ops",
              description: "Operations",
              owner_id: "ou_owner",
              owner_id_type: "open_id",
              external: false,
              tenant_key: "tenant-1",
              labels: ["warehouse", "priority"],
              chat_status: "normal",
            }, {
              chat_id: "oc_legacy",
              name: "Legacy extension",
              chat_mode: "group",
            }],
            has_more: true,
            page_token: "next-page",
          };
        },
        download: async () => ({ data: new Uint8Array(), contentType: "application/octet-stream", fileName: "" }),
      },
      sessionSource: async () => ({ platform: "feishu" }),
    });

    const response = await registry.execute("feishu_im_bot_list_groups", {
      page_size: 2,
      page_token: "current-page",
    }, context(root));
    const payload = JSON.parse(String(response.content[0]?.text));
    expect(calls).toEqual([{
      path: "/im/v1/chats",
      params: { page_size: "2", page_token: "current-page" },
    }]);
    expect(payload).toMatchObject({
      has_more: true,
      page_token: "next-page",
      groups: [{
        chat_id: "oc_ops",
        avatar: "https://example.test/avatar.png",
        name: "Ops",
        description: "Operations",
        owner_id: "ou_owner",
        owner_id_type: "open_id",
        external: false,
        tenant_key: "tenant-1",
        labels: ["warehouse", "priority"],
        chat_status: "normal",
      }, {
        chat_id: "oc_legacy",
        chat_mode: "group",
      }],
    });
    expect(payload.groups[0]).not.toHaveProperty("chat_mode");
    expect(payload.groups[1]).toEqual({
      chat_id: "oc_legacy",
      name: "Legacy extension",
      chat_mode: "group",
    });
    for (const group of payload.groups) {
      expect(group).not.toHaveProperty("chat_type");
      expect(group).not.toHaveProperty("member_count");
    }
  });

  test("rejects card and undeclared resource keys before download", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-feishu-card-resource-"));
    roots.push(root);
    let mode: "card" | "image" = "card";
    let downloads = 0;
    const api: FeishuImToolApi = {
      get: async () => ({ items: [mode === "card"
        ? { message_id: "om_card", msg_type: "interactive", body: { content: "{\"json_card\":\"{}\"}" } }
        : { message_id: "om_card", msg_type: "image", body: { content: "{\"image_key\":\"img_real\"}" } }] }),
      download: async () => {
        downloads += 1;
        return { data: new Uint8Array(), contentType: "image/png", fileName: "x.png" };
      },
    };
    const registry = new ToolRegistry();
    registerFeishuImTools(registry, { api, sessionSource: async () => ({ platform: "feishu" }) });
    const call = () => registry.execute("feishu_im_bot_fetch_resource", {
      message_id: "om_card", file_key: "img_v3_internal", type: "image",
    }, context(root));

    const cardError = await call().catch((error) => error);
    expect(cardError).toBeInstanceOf(ToolExecutionError);
    expect(cardError.details).toMatchObject({
      cause_known: true,
      verified_reason: "interactive_card_not_downloadable_resource",
      mapping_id: "local:feishu_interactive_card_resource:v1",
      inference_policy: "verified_reason_only",
    });
    expect(JSON.parse(cardError.modelContent())).toMatchObject({
      type: "tool_failure",
      cause_known: true,
      verified_reason: "interactive_card_not_downloadable_resource",
    });
    mode = "image";
    const mismatch = await call().catch((error) => error);
    expect(mismatch).toBeInstanceOf(ToolExecutionError);
    expect(mismatch.details).toMatchObject({ verified_reason: "resource_not_declared_by_message" });
    expect(downloads).toBe(0);
  });

  test("uses the tested local mapping when Feishu returns no validation item", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-feishu-missing-message-"));
    roots.push(root);
    let downloads = 0;
    const registry = new ToolRegistry();
    registerFeishuImTools(registry, {
      api: {
        get: async () => ({ items: [] }),
        download: async () => {
          downloads += 1;
          return { data: new Uint8Array(), contentType: "image/png", fileName: "x.png" };
        },
      },
      sessionSource: async () => ({ platform: "feishu" }),
    });
    const failure = await registry.execute("feishu_im_bot_fetch_resource", {
      message_id: "om_missing", file_key: "img_missing", type: "image",
    }, context(root)).catch((error) => error);
    expect(failure).toBeInstanceOf(ToolExecutionError);
    expect(failure.details).toMatchObject({
      cause_known: true,
      verified_reason: "message_not_returned_by_feishu",
      mapping_id: "local:feishu_message_not_returned:v1",
      observed_message: "Feishu did not return the message needed to validate this resource.",
    });
    expect(downloads).toBe(0);
  });

  test("validates post and content_v2 resources before downloading", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-feishu-post-resource-"));
    roots.push(root);
    const downloads: string[] = [];
    const api: FeishuImToolApi = {
      get: async () => ({ items: [{
        message_id: "om_post",
        msg_type: "post",
        body: { content: JSON.stringify({
          zh_cn: { content_v2: [[
            { tag: "md", text: "![chart](img_post)" },
            { tag: "file", file_key: "file_post" },
          ]] },
        }) },
      }] }),
      download: async (_messageId, fileKey, type) => {
        downloads.push(`${type}:${fileKey}`);
        return { data: new Uint8Array([1]), contentType: type === "image" ? "image/png" : "application/octet-stream", fileName: `${fileKey}.bin` };
      },
    };
    const registry = new ToolRegistry();
    registerFeishuImTools(registry, { api, sessionSource: async () => ({ platform: "feishu" }) });
    await registry.execute("feishu_im_bot_fetch_resource", {
      message_id: "om_post", file_key: "img_post", type: "image",
    }, context(root));
    await registry.execute("feishu_im_bot_fetch_resource", {
      message_id: "om_post", file_key: "file_post", type: "file",
    }, context(root));
    expect(downloads).toEqual(["image:img_post", "file:file_post"]);
  });

  test("preserves observed Feishu error fields without inventing a cause", () => {
    const error = Object.assign(new Error("Request failed with status code 400"), {
      response: {
        status: 400,
        data: {
          code: 200000,
          msg: "invalid request authorization: Bearer private-credential token=private",
          log_id: "log-1",
        },
      },
    });
    const normalized = normalizeFeishuToolError("GET /resource", error);
    expect(normalized.message).toBe("invalid request authorization=[redacted] [redacted] token=[redacted]");
    expect(normalized.details).toMatchObject({
      cause_known: false,
      http_status: 400,
      provider_code: 200000,
      log_id: "log-1",
      inference_policy: "verified_reason_only",
    });
    expect(normalized.details?.observed_message).not.toContain("private-credential");
    expect(normalized.details?.observed_message).not.toContain("token=private");
    expect(normalized.details).not.toHaveProperty("verified_reason");
  });

  test("does not replace a provider error without an exact fixture-backed mapping", () => {
    const error = Object.assign(new Error("Request failed with status code 400"), {
      response: {
        status: 400,
        data: { code: 99991672, msg: "missing application scope", log_id: "log-scope" },
      },
    });
    const normalized = normalizeFeishuToolError("GET /im/v1/messages", error);
    expect(normalized.code).toBe("external_api_error");
    expect(normalized.message).toBe("missing application scope");
    expect(normalized.details).toMatchObject({
      cause_known: false,
      http_status: 400,
      provider_code: 99991672,
      log_id: "log-scope",
      retryability: "unknown",
      inference_policy: "verified_reason_only",
    });
    expect(normalized.details).not.toHaveProperty("verified_reason");
    expect(normalized.details).not.toHaveProperty("mapping_id");
  });

  test("fails closed when resource provenance cannot be checked", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-feishu-resource-validation-"));
    roots.push(root);
    let downloads = 0;
    const api: FeishuImToolApi = {
      get: async () => {
        throw Object.assign(new Error("Request failed with status code 503"), {
          response: {
            status: 503,
            data: {
              code: "UPSTREAM_UNAVAILABLE",
              msg: "temporary failure",
              error: { subcode: "MESSAGE_LOOKUP_FAILED", log_id: "log-validation" },
            },
          },
        });
      },
      download: async () => {
        downloads += 1;
        return { data: new Uint8Array(), contentType: "image/png", fileName: "x.png" };
      },
    };
    const registry = new ToolRegistry();
    registerFeishuImTools(registry, { api, sessionSource: async () => ({ platform: "feishu" }) });

    const failure = await registry.execute("feishu_im_bot_fetch_resource", {
      message_id: "om_unknown", file_key: "img_unknown", type: "image",
    }, context(root)).catch((error) => error);
    expect(failure).toBeInstanceOf(ToolExecutionError);
    expect(failure.code).toBe("external_api_error");
    expect(failure.details).toMatchObject({
      cause_known: false,
      http_status: 503,
      provider_code: "UPSTREAM_UNAVAILABLE",
      provider_subcode: "MESSAGE_LOOKUP_FAILED",
      log_id: "log-validation",
    });
    expect(downloads).toBe(0);
  });
});
