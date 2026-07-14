import { mkdirSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import * as Lark from "@larksuiteoapi/node-sdk";
import type { JsonObject } from "@lxe/protocol";
import type { ToolRegistry } from "@lxe/runtime";
import type { FeishuConfig } from "./config";

export interface FeishuImToolApi {
  get(path: string, params: Record<string, string>, signal?: AbortSignal): Promise<JsonObject>;
  download(
    messageId: string,
    fileKey: string,
    type: "image" | "file",
    signal?: AbortSignal,
  ): Promise<{ data: Uint8Array; contentType: string; fileName: string }>;
}

interface RegisterFeishuImToolsOptions {
  api: FeishuImToolApi;
  workspaceRoot: string;
  sessionSource(sessionId: string): Promise<JsonObject | undefined>;
}

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string => String(value ?? "").trim();
const result = (payload: JsonObject, files?: string[]) => ({
  content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  ...(files ? { files } : {}),
});
const pageSize = (value: unknown, maximum: number): number => {
  const size = Number(value ?? maximum);
  if (!Number.isInteger(size) || size < 1 || size > maximum) throw new Error(`page_size 必须在 1-${maximum} 之间`);
  return size;
};
const sortType = (value: unknown): string => {
  const rule = text(value) || "create_time_desc";
  if (!new Set(["create_time_asc", "create_time_desc"]).has(rule)) {
    throw new Error("sort_rule 只能是 create_time_asc 或 create_time_desc");
  }
  return rule === "create_time_asc" ? "ByCreateTimeAsc" : "ByCreateTimeDesc";
};

const relativeRange = (value: unknown): { start_time?: string; end_time?: string } => {
  const rule = text(value).toLowerCase();
  if (!rule) return {};
  const now = new Date();
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  let start: Date;
  let end = now;
  if (rule === "today") start = startOfToday;
  else if (rule === "yesterday") {
    end = new Date(startOfToday.getTime() - 1_000);
    start = new Date(startOfToday.getTime() - 86_400_000);
  } else if (rule === "this_week") {
    const day = (startOfToday.getDay() + 6) % 7;
    start = new Date(startOfToday.getTime() - day * 86_400_000);
  } else {
    const match = rule.match(/^last_(\d+)_(minutes|hours|days)$/);
    if (!match) throw new Error(`不支持的 relative_time: ${rule}`);
    const count = Number(match[1]);
    const unit = match[2] === "minutes" ? 60 : match[2] === "hours" ? 3_600 : 86_400;
    start = new Date(now.getTime() - count * unit * 1_000);
  }
  return { start_time: String(Math.trunc(start.getTime() / 1_000)), end_time: String(Math.trunc(end.getTime() / 1_000)) };
};

const isoSeconds = (value: unknown): string => {
  const raw = text(value);
  if (!raw) return "";
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) throw new Error(`无效时间格式: ${raw}`);
  return String(Math.trunc(parsed / 1_000));
};

const messageContent = (item: Record<string, unknown>): string => {
  const raw = text(object(item.body).content);
  let body: Record<string, unknown> = {};
  try { body = object(JSON.parse(raw)); } catch { return raw; }
  if (typeof body.text === "string") return body.text;
  if (typeof body.title === "string" || Array.isArray(body.content)) {
    const rows = Array.isArray(body.content) ? body.content : [];
    const cells = rows.flatMap((row) => Array.isArray(row) ? row : []).map(object);
    return [text(body.title), ...cells.map((cell) => text(cell.text) || text(cell.name))].filter(Boolean).join("\n");
  }
  return raw;
};

const messagePayload = (raw: unknown): JsonObject => {
  const item = object(raw);
  const sender = object(item.sender);
  const senderId = object(sender.id);
  return {
    message_id: text(item.message_id),
    msg_type: text(item.msg_type) || "unknown",
    content: messageContent(item),
    sender: {
      open_id: text(senderId.open_id) || text(sender.id) || text(sender.open_id),
      name: text(sender.name) || text(senderId.name) || text(senderId.user_id),
    },
    create_time: text(item.create_time),
    thread_id: text(item.thread_id),
    chat_id: text(item.chat_id),
    ...(text(item.parent_id) ? { reply_to: text(item.parent_id) } : {}),
  };
};

const commonMessages = async (
  options: RegisterFeishuImToolsOptions,
  input: JsonObject,
  containerType: "chat" | "thread",
  containerId: string,
  signal: AbortSignal,
): Promise<JsonObject> => {
  const relative = text(input.relative_time);
  if (relative && (text(input.start_time) || text(input.end_time))) {
    throw new Error("relative_time 和 start_time/end_time 不能同时使用");
  }
  const range = relative ? relativeRange(relative) : {
    ...(text(input.start_time) ? { start_time: isoSeconds(input.start_time) } : {}),
    ...(text(input.end_time) ? { end_time: isoSeconds(input.end_time) } : {}),
  };
  const params: Record<string, string> = {
    container_id_type: containerType,
    container_id: containerId,
    page_size: String(pageSize(input.page_size, 50)),
    sort_type: sortType(input.sort_rule),
    card_msg_content_type: "raw_card_content",
    user_id_type: "open_id",
    ...range,
    ...(text(input.page_token) ? { page_token: text(input.page_token) } : {}),
  };
  const data = await options.api.get("/im/v1/messages", params, signal);
  const items = Array.isArray(data.items) ? data.items : [];
  return {
    [`${containerType}_id`]: containerId,
    messages: items.map(messagePayload),
    has_more: data.has_more === true,
    page_token: text(data.page_token),
  };
};

export function registerFeishuImTools(registry: ToolRegistry, options: RegisterFeishuImToolsOptions): void {
  registry.register({
    name: "feishu_im_bot_list_groups",
    description: "List Feishu groups the bot can access.",
    input_schema: { type: "object", properties: { page_size: { type: "integer", minimum: 1, maximum: 100 }, page_token: { type: "string" } }, additionalProperties: false },
    execute: async (input, context) => {
      const params = { page_size: String(pageSize(input.page_size, 100)), ...(text(input.page_token) ? { page_token: text(input.page_token) } : {}) };
      const data = await options.api.get("/im/v1/chats", params, context.handle.signal);
      const items = Array.isArray(data.items) ? data.items.map(object) : [];
      return result({
        groups: items.map((item) => ({
          chat_id: text(item.chat_id), name: text(item.name), chat_mode: text(item.chat_mode), chat_type: text(item.chat_type),
          description: text(item.description), member_count: Number(item.member_count ?? 0),
        })),
        has_more: data.has_more === true,
        page_token: text(data.page_token),
      });
    },
  });
  registry.register({
    name: "feishu_im_bot_get_messages",
    description: "Read Feishu chat history with bot permissions.",
    input_schema: { type: "object", properties: {
      chat_id: { type: "string" }, relative_time: { type: "string" }, start_time: { type: "string" }, end_time: { type: "string" },
      page_size: { type: "integer", minimum: 1, maximum: 50 }, page_token: { type: "string" },
      sort_rule: { type: "string", enum: ["create_time_asc", "create_time_desc"] },
    }, additionalProperties: false },
    execute: async (input, context) => {
      const source = await options.sessionSource(context.session_id);
      const current = source?.platform === "feishu" ? text(source.chat_id) : "";
      const chatId = text(input.chat_id) || current;
      if (!chatId) throw new Error("chat_id 不能为空；当前会话不是飞书会话");
      return result(await commonMessages(options, input, "chat", chatId, context.handle.signal));
    },
  });
  registry.register({
    name: "feishu_im_bot_get_thread_messages",
    description: "Read Feishu thread replies with bot permissions.",
    input_schema: { type: "object", properties: {
      thread_id: { type: "string" }, page_size: { type: "integer", minimum: 1, maximum: 50 }, page_token: { type: "string" },
      sort_rule: { type: "string", enum: ["create_time_asc", "create_time_desc"] },
    }, required: ["thread_id"], additionalProperties: false },
    execute: async (input, context) => {
      const threadId = text(input.thread_id);
      if (!threadId) throw new Error("thread_id 不能为空");
      return result(await commonMessages(options, input, "thread", threadId, context.handle.signal));
    },
  });
  registry.register({
    name: "feishu_im_bot_fetch_resource",
    description: "Download a Feishu image or file resource into workspace artifacts.",
    input_schema: { type: "object", properties: {
      message_id: { type: "string" }, file_key: { type: "string" }, type: { type: "string", enum: ["image", "file"] },
    }, required: ["message_id", "file_key", "type"], additionalProperties: false },
    execute: async (input, context) => {
      const messageId = text(input.message_id);
      const fileKey = text(input.file_key);
      const type = text(input.type);
      if (!messageId || !fileKey || !["image", "file"].includes(type)) throw new Error("message_id、file_key 和有效 type 必填");
      const resource = await options.api.download(messageId, fileKey, type as "image" | "file", context.handle.signal);
      const directory = resolve(options.workspaceRoot, "artifacts", "feishu", "im_read", messageId.replaceAll(/[^\w.-]/g, "_"));
      mkdirSync(directory, { recursive: true });
      const fallbackExtension = resource.contentType === "image/png" ? ".png" : "";
      const rawName = basename(resource.fileName || `${type}_${fileKey}${fallbackExtension}`);
      const safeName = rawName.replaceAll(/[<>:"/\\|?*\x00-\x1f]/g, "_") || `${type}_${fileKey}`;
      let path = join(directory, safeName);
      if (!extname(path) && fallbackExtension) path += fallbackExtension;
      writeFileSync(path, resource.data);
      return result({ message_id: messageId, file_key: fileKey, type, saved_path: path, content_type: resource.contentType, size_bytes: resource.data.byteLength }, [path]);
    },
  });
}

type LooseClient = { request(options: Record<string, unknown>): Promise<unknown> };

export function createOfficialFeishuImToolApi(config: FeishuConfig): FeishuImToolApi {
  const domain = config.domain === "feishu" ? Lark.Domain.Feishu : config.domain === "lark" ? Lark.Domain.Lark : config.domain;
  const client = new Lark.Client({ appId: config.appId, appSecret: config.appSecret, domain }) as unknown as LooseClient;
  return {
    get: async (path, params, signal) => {
      const response = object(await client.request({ method: "GET", url: `/open-apis${path}`, params, signal }));
      const payload = object(response.data ?? response);
      const code = Number(response.code ?? 0);
      if (code !== 0) throw new Error(`Feishu API error: ${text(response.msg) || code}`);
      return payload as JsonObject;
    },
    download: async (messageId, fileKey, type, signal) => {
      const response = object(await client.request({
        method: "GET",
        url: `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(fileKey)}`,
        params: { type },
        responseType: "arraybuffer",
        $return_headers: true,
        signal,
      }));
      const headers = object(response.headers);
      const disposition = text(headers["content-disposition"]);
      const fileName = decodeURIComponent(disposition.match(/filename\*?=(?:UTF-8'')?["']?([^"';]+)/i)?.[1] ?? "");
      const raw = response.data;
      const data = raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayBuffer);
      return { data, contentType: text(headers["content-type"]) || "application/octet-stream", fileName };
    },
  };
}
