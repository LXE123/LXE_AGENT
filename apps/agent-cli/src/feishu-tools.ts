import { mkdirSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import * as Lark from "@larksuiteoapi/node-sdk";
import { inspectHttpError } from "@lxe/core";
import type { JsonObject } from "@lxe/protocol";
import {
  ToolExecutionError,
  safeToolFailureObservation,
  type ToolFailureDetails,
  type ToolRegistry,
} from "@lxe/runtime";
import type { AgentFeishuConfig } from "./feishu-runtime-config";
import { findVerifiedFeishuFailureMapping } from "./feishu-failure-mappings";

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
  sessionSource(sessionId: string): Promise<JsonObject | undefined>;
}

interface RegisterConfiguredFeishuImToolsOptions {
  sessionSource(sessionId: string): Promise<JsonObject | undefined>;
  createApi?: (config: AgentFeishuConfig) => FeishuImToolApi;
}

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string => String(value ?? "").trim();
const safeFeishuToolMessage = (value: unknown): string => safeToolFailureObservation(text(value));

interface RestTypedIds {
  id: string;
  id_type: string;
  open_id: string;
  user_id: string;
  union_id: string;
}

const restTypedIds = (
  value: unknown,
  idTypeValue: unknown,
  legacy: Record<string, unknown> = {},
): RestTypedIds => {
  const idObject = object(value);
  const idType = text(idTypeValue);
  const scalarId = typeof value === "string" || typeof value === "number" ? text(value) : "";
  const openId = text(idObject.open_id) || text(legacy.open_id) || (idType === "open_id" ? scalarId : "");
  const userId = text(idObject.user_id) || text(legacy.user_id) || (idType === "user_id" ? scalarId : "");
  const unionId = text(idObject.union_id) || text(legacy.union_id) || (idType === "union_id" ? scalarId : "");
  return {
    id: scalarId || openId || userId || unionId,
    id_type: idType || (openId ? "open_id" : userId ? "user_id" : unionId ? "union_id" : ""),
    open_id: openId,
    user_id: userId,
    union_id: unionId,
  };
};

const restMessageSender = (value: unknown) => {
  const sender = object(value);
  const ids = restTypedIds(sender.id, sender.id_type, sender);
  const legacyId = object(sender.id);
  return {
    ...ids,
    sender_type: text(sender.sender_type),
    tenant_key: text(sender.tenant_key),
    name: text(sender.sender_name) || text(sender.name) || text(legacyId.name),
  };
};

const restMessageMentions = (value: unknown) => (Array.isArray(value) ? value : []).map((raw) => {
  const mention = object(raw);
  const ids = restTypedIds(mention.id, mention.id_type, mention);
  return {
    key: text(mention.key),
    name: text(mention.name),
    ...ids,
  };
});

const knownFeishuFailure = (
  operation: string,
  localCode: string,
): ToolExecutionError => {
  const mapping = findVerifiedFeishuFailureMapping({ operation, localCode });
  if (!mapping) throw new Error(`Missing verified Feishu failure mapping for ${operation}:${localCode}`);
  return new ToolExecutionError(mapping.errorCode, mapping.replacement, {
    type: "tool_failure",
    operation,
    cause_known: true,
    observed_message: mapping.replacement,
    verified_reason: mapping.verifiedReason,
    mapping_id: mapping.mappingId,
    provider: "feishu",
    retryability: mapping.retryability,
    next_action: "Report the verified reason and do not retry the same resource request.",
    inference_policy: "verified_reason_only",
  });
};

export const normalizeFeishuToolError = (operation: string, cause: unknown): ToolExecutionError => {
  if (cause instanceof ToolExecutionError) return cause;
  const observed = inspectHttpError(cause);
  const payload = observed.responseData;
  const rawCode = payload.code;
  const providerCode = typeof rawCode === "number" && Number.isFinite(rawCode)
    ? rawCode
    : typeof rawCode === "string" && rawCode.trim()
      ? rawCode.trim()
      : undefined;
  const errorDetail = object(payload.error);
  const observedMessage = safeFeishuToolMessage(payload.msg ?? payload.message ?? observed.message)
    || "Feishu API request failed without an error message";
  const rawSubcode = errorDetail.subcode ?? errorDetail.code;
  const providerSubcode = typeof rawSubcode === "number" && Number.isFinite(rawSubcode)
    ? rawSubcode
    : typeof rawSubcode === "string" && rawSubcode.trim()
      ? rawSubcode.trim()
      : undefined;
  const logId = text(payload.log_id ?? errorDetail.log_id);
  const mapping = findVerifiedFeishuFailureMapping({
    operation,
    ...(providerCode !== undefined ? { providerCode } : {}),
    ...(providerSubcode !== undefined ? { providerSubcode } : {}),
  });
  const details: ToolFailureDetails = {
    type: "tool_failure",
    operation,
    cause_known: Boolean(mapping),
    observed_message: observedMessage,
    ...(mapping ? { verified_reason: mapping.verifiedReason, mapping_id: mapping.mappingId } : {}),
    provider: "feishu",
    ...(observed.httpStatus ? { http_status: observed.httpStatus } : {}),
    ...(providerCode !== undefined ? { provider_code: providerCode } : {}),
    ...(providerSubcode !== undefined ? { provider_subcode: providerSubcode } : {}),
    ...(logId ? { log_id: logId } : {}),
    retryability: mapping?.retryability ?? "unknown",
    next_action: mapping
      ? "Report the verified reason and follow the mapped retry policy."
      : "Report only the observed API failure. Do not infer expiration, permissions, network, file format, or client version.",
    inference_policy: "verified_reason_only",
  };
  return new ToolExecutionError(mapping?.errorCode ?? "external_api_error", mapping?.replacement ?? observedMessage, details);
};
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
  let content = "";
  if (typeof body.text === "string") content = body.text;
  if (typeof body.title === "string" || Array.isArray(body.content)) {
    const rows = Array.isArray(body.content) ? body.content : [];
    const cells = rows.flatMap((row) => Array.isArray(row) ? row : []).map(object);
    content = [text(body.title), ...cells.map((cell) => text(cell.text) || text(cell.name))].filter(Boolean).join("\n");
  }
  if (!content) content = raw;
  for (const mention of restMessageMentions(item.mentions)) {
    if (mention.key && mention.name) content = content.replaceAll(mention.key, `@${mention.name}`);
  }
  return content;
};

const messagePayload = (raw: unknown): JsonObject => {
  const item = object(raw);
  const sender = restMessageSender(item.sender);
  const mentions = restMessageMentions(item.mentions);
  return {
    message_id: text(item.message_id),
    msg_type: text(item.msg_type) || "unknown",
    content: messageContent(item),
    sender: {
      id: sender.id,
      id_type: sender.id_type,
      sender_type: sender.sender_type,
      name: sender.name || sender.id,
      ...(sender.open_id ? { open_id: sender.open_id } : {}),
      ...(sender.user_id ? { user_id: sender.user_id } : {}),
      ...(sender.union_id ? { union_id: sender.union_id } : {}),
    },
    mentions: mentions.map((mention) => ({
      key: mention.key,
      name: mention.name,
      id: mention.id,
      id_type: mention.id_type,
      ...(mention.open_id ? { open_id: mention.open_id } : {}),
      ...(mention.user_id ? { user_id: mention.user_id } : {}),
      ...(mention.union_id ? { union_id: mention.union_id } : {}),
    })),
    create_time: text(item.create_time),
    thread_id: text(item.thread_id),
    chat_id: text(item.chat_id),
    ...(text(item.parent_id) ? { reply_to: text(item.parent_id) } : {}),
  };
};

type MessageResourceType = "image" | "file";

const declaredMessageResources = (item: Record<string, unknown>): Map<string, MessageResourceType> => {
  const declared = new Map<string, MessageResourceType>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    const current = object(value);
    if (Object.keys(current).length === 0) return;
    const imageKey = text(current.image_key);
    const fileKey = text(current.file_key);
    if (imageKey) declared.set(imageKey, "image");
    if (fileKey) declared.set(fileKey, "file");
    if (text(current.tag).toLowerCase() === "md") {
      for (const match of String(current.text ?? "").matchAll(/!\[[^\]]*\]\((img_[A-Za-z0-9_-]+)\)/gu)) {
        if (match[1]) declared.set(match[1], "image");
      }
    }
    for (const child of Object.values(current)) visit(child);
  };
  const raw = text(object(item.body).content);
  try { visit(JSON.parse(raw)); } catch { /* An invalid body declares no downloadable resources. */ }
  return declared;
};

const validateMessageResource = async (
  options: RegisterFeishuImToolsOptions,
  messageId: string,
  fileKey: string,
  type: MessageResourceType,
  signal: AbortSignal,
): Promise<void> => {
  const operation = "feishu_im_bot_fetch_resource.validate";
  let data: JsonObject;
  try {
    data = await options.api.get(`/im/v1/messages/${encodeURIComponent(messageId)}`, {
      user_id_type: "open_id",
      card_msg_content_type: "raw_card_content",
    }, signal);
  } catch (cause) {
    throw normalizeFeishuToolError(operation, cause);
  }
  const items = Array.isArray(data.items) ? data.items.map(object) : [];
  const item = items.find((candidate) => text(candidate.message_id) === messageId) ?? items[0];
  if (!item) {
    throw knownFeishuFailure(
      operation,
      "message_not_returned_by_feishu",
    );
  }
  const messageType = text(item.msg_type ?? item.message_type).toLowerCase();
  if (messageType === "interactive") {
    throw knownFeishuFailure(
      operation,
      "interactive_card_not_downloadable_resource",
    );
  }
  const declaredType = declaredMessageResources(item).get(fileKey);
  if (declaredType !== type) {
    throw knownFeishuFailure(
      operation,
      "resource_not_declared_by_message",
    );
  }
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
        groups: items.map((item) => {
          const avatar = text(item.avatar);
          const description = text(item.description);
          const ownerId = text(item.owner_id);
          const ownerIdType = text(item.owner_id_type);
          const tenantKey = text(item.tenant_key);
          const chatStatus = text(item.chat_status);
          const chatMode = text(item.chat_mode);
          return {
            chat_id: text(item.chat_id),
            name: text(item.name),
            ...(avatar ? { avatar } : {}),
            ...(description ? { description } : {}),
            ...(ownerId ? { owner_id: ownerId } : {}),
            ...(ownerIdType ? { owner_id_type: ownerIdType } : {}),
            ...(typeof item.external === "boolean" ? { external: item.external } : {}),
            ...(tenantKey ? { tenant_key: tenantKey } : {}),
            ...(Array.isArray(item.labels) ? { labels: item.labels.map(text).filter(Boolean) } : {}),
            ...(chatStatus ? { chat_status: chatStatus } : {}),
            ...(chatMode ? { chat_mode: chatMode } : {}),
          };
        }),
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
    description: "Download an ordinary Feishu message attachment into workspace artifacts. The key must be declared by the target image, file, audio, video, post, or content_v2 message. Interactive Card image/icon keys are not downloadable resources.",
    input_schema: { type: "object", properties: {
      message_id: { type: "string" }, file_key: { type: "string" }, type: { type: "string", enum: ["image", "file"] },
    }, required: ["message_id", "file_key", "type"], additionalProperties: false },
    execute: async (input, context) => {
      const messageId = text(input.message_id);
      const fileKey = text(input.file_key);
      const type = text(input.type);
      if (!messageId || !fileKey || !["image", "file"].includes(type)) throw new Error("message_id、file_key 和有效 type 必填");
      await validateMessageResource(options, messageId, fileKey, type as MessageResourceType, context.handle.signal);
      const resource = await options.api.download(messageId, fileKey, type as MessageResourceType, context.handle.signal);
      const directory = resolve(
        context.workspace.worktree,
        "artifacts",
        "feishu",
        "im_read",
        messageId.replaceAll(/[^\w.-]/g, "_"),
      );
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

export function registerConfiguredFeishuImTools(
  registry: ToolRegistry,
  config: AgentFeishuConfig,
  options: RegisterConfiguredFeishuImToolsOptions,
): boolean {
  if (config.missingRequired().length > 0) return false;
  registerFeishuImTools(registry, {
    api: (options.createApi ?? createOfficialFeishuImToolApi)(config),
    sessionSource: options.sessionSource,
  });
  return true;
}

type LooseClient = { request(options: Record<string, unknown>): Promise<unknown> };

export function createOfficialFeishuImToolApi(config: AgentFeishuConfig): FeishuImToolApi {
  const domain = config.domain === "feishu" ? Lark.Domain.Feishu : config.domain === "lark" ? Lark.Domain.Lark : config.domain;
  const client = new Lark.Client({ appId: config.appId, appSecret: config.appSecret, domain }) as unknown as LooseClient;
  return {
    get: async (path, params, signal) => {
      try {
        const response = object(await client.request({ method: "GET", url: `/open-apis${path}`, params, signal }));
        const payload = object(response.data ?? response);
        const code = Number(response.code ?? 0);
        if (code !== 0) {
          throw Object.assign(new Error(text(response.msg) || `Feishu API code ${code}`), {
            response: { status: 200, data: response },
          });
        }
        return payload as JsonObject;
      } catch (cause) {
        throw normalizeFeishuToolError(`GET ${path}`, cause);
      }
    },
    download: async (messageId, fileKey, type, signal) => {
      const path = `/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(fileKey)}`;
      try {
        const response = object(await client.request({
          method: "GET",
          url: `/open-apis${path}`,
          params: { type },
          responseType: "arraybuffer",
          $return_headers: true,
          signal,
        }));
        const headers = object(response.headers);
        const disposition = text(headers["content-disposition"]);
        let fileName = disposition.match(/filename\*?=(?:UTF-8'')?["']?([^"';]+)/i)?.[1] ?? "";
        try { fileName = decodeURIComponent(fileName); } catch { /* Keep the server-provided name. */ }
        const raw = response.data;
        const data = raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayBuffer);
        return { data, contentType: text(headers["content-type"]) || "application/octet-stream", fileName };
      } catch (cause) {
        throw normalizeFeishuToolError(`GET ${path}`, cause);
      }
    },
  };
}
