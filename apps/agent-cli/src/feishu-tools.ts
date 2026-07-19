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

const knownFeishuFailure = (
  operation: string,
  code: "failed_precondition" | "not_found" | "permission_denied",
  reason: string,
  message: string,
  extra: Partial<ToolFailureDetails> = {},
): ToolExecutionError => new ToolExecutionError(code, message, {
  type: "tool_failure",
  operation,
  cause_known: true,
  observed_message: message,
  verified_reason: reason,
  provider: "feishu",
  retryability: "not_retryable",
  next_action: "Report the verified reason and do not retry the same resource request.",
  inference_policy: "verified_reason_only",
  ...extra,
});

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
  const numericProviderCode = Number(providerCode);
  const errorDetail = object(payload.error);
  const observedMessage = safeFeishuToolMessage(payload.msg ?? payload.message ?? observed.message)
    || "Feishu API request failed without an error message";
  const rawSubcode = errorDetail.subcode ?? errorDetail.code;
  const providerSubcode = typeof rawSubcode === "number" && Number.isFinite(rawSubcode)
    ? rawSubcode
    : typeof rawSubcode === "string" && rawSubcode.trim()
      ? rawSubcode.trim()
      : /ErrCode:\s*(\d+)/iu.exec(observedMessage)?.[1];
  const logId = text(payload.log_id ?? errorDetail.log_id);
  const permissionMissing = numericProviderCode === 99991672;
  const messageUnavailable = numericProviderCode === 230011 || numericProviderCode === 231003;
  const details: ToolFailureDetails = {
    type: "tool_failure",
    operation,
    cause_known: permissionMissing || messageUnavailable,
    observed_message: observedMessage,
    ...(permissionMissing ? { verified_reason: "missing_application_scope" } : {}),
    ...(messageUnavailable ? { verified_reason: "message_unavailable" } : {}),
    provider: "feishu",
    ...(observed.httpStatus ? { http_status: observed.httpStatus } : {}),
    ...(providerCode !== undefined ? { provider_code: providerCode } : {}),
    ...(providerSubcode !== undefined ? { provider_subcode: providerSubcode } : {}),
    ...(logId ? { log_id: logId } : {}),
    retryability: permissionMissing || messageUnavailable ? "not_retryable" : "unknown",
    next_action: permissionMissing
      ? "Report that the Feishu application is missing a required scope. Do not retry."
      : messageUnavailable
        ? "Report that Feishu marks the message unavailable. Do not retry."
        : "Report only the observed API failure. Do not infer expiration, permissions, network, file format, or client version.",
    inference_policy: "verified_reason_only",
  };
  const display = permissionMissing
    ? "Feishu API request failed because the application is missing a required scope."
    : messageUnavailable
      ? "Feishu API request failed because the message is unavailable."
      : "Feishu API request failed; the cause was not determined.";
  return new ToolExecutionError(permissionMissing ? "permission_denied" : messageUnavailable ? "not_found" : "external_api_error", display, details);
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
      "not_found",
      "message_not_returned_by_feishu",
      "Feishu did not return the message needed to validate this resource.",
    );
  }
  const messageType = text(item.msg_type ?? item.message_type).toLowerCase();
  if (messageType === "interactive") {
    throw knownFeishuFailure(
      operation,
      "failed_precondition",
      "interactive_card_not_downloadable_resource",
      "Interactive Card image and icon keys are not downloadable message resources.",
    );
  }
  const declaredType = declaredMessageResources(item).get(fileKey);
  if (declaredType !== type) {
    throw knownFeishuFailure(
      operation,
      "failed_precondition",
      "resource_not_declared_by_message",
      "The requested resource key and type are not declared by the Feishu message.",
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
