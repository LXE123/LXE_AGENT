import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import * as Lark from "@larksuiteoapi/node-sdk";
import type { JsonObject } from "@lxe/protocol";
import type { FeishuCardKitApi } from "./cardkit";
import type { FeishuConfig } from "./config";
import type { FeishuMediaApi } from "./media";
import type { FeishuInboundResourceApi } from "./resources";
import type { FeishuReactionPort } from "./typing";
import {
  FeishuApiResponseError,
  normalizeFeishuTransportError,
  parseFeishuEnvelope,
} from "./response";

export const FEISHU_EVENT_TYPES = [
  "im.message.receive_v1",
] as const;

export interface FeishuSdkCallbacks {
  onMessage(data: unknown): Promise<void> | void;
  onReady(): void;
  onError(error: Error): void;
  onReconnecting(): void;
  onReconnected(): void;
}

export interface FeishuConnectionPort {
  start(): Promise<void>;
  stop(force?: boolean): Promise<void>;
  status(): JsonObject;
}

export interface FeishuSdkServices {
  connection: FeishuConnectionPort;
  api: FeishuMediaApi;
  cardkit: FeishuCardKitApi;
  reactions: FeishuReactionPort;
  resources?: FeishuInboundResourceApi;
  probeBotIdentity(): Promise<{ openId: string; name: string }>;
}

interface Constructors {
  Client: new (options: Record<string, unknown>) => unknown;
  EventDispatcher: new (options: Record<string, unknown>) => {
    register(handlers: Record<string, (data: unknown) => Promise<void> | void>): unknown;
  };
  WSClient: new (options: Record<string, unknown>) => {
    start(options: { eventDispatcher: unknown }): Promise<void> | void;
    close(options?: { force?: boolean }): Promise<void> | void;
    getConnectionStatus?: () => unknown;
  };
}

type LooseClient = {
  request(options: Record<string, unknown>): Promise<unknown>;
  cardkit: { v1: {
    card: {
      create(payload: unknown): Promise<unknown>;
      update(payload: unknown): Promise<unknown>;
      settings(payload: unknown): Promise<unknown>;
    };
    cardElement: { content(payload: unknown): Promise<unknown> };
  } };
  im: { v1: {
    message: {
      reply(payload: unknown): Promise<unknown>;
      create(payload: unknown): Promise<unknown>;
    };
    messageReaction: {
      create(payload: unknown): Promise<unknown>;
      delete(payload: unknown): Promise<unknown>;
    };
    file: { create(payload: unknown): Promise<unknown> };
    image: { create(payload: unknown): Promise<unknown> };
  } };
};

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
const jsonObject = (value: unknown): JsonObject => object(value) as JsonObject;
const apiResponse = (value: unknown): JsonObject => {
  const response = object(value);
  const rawCode = response.code;
  const code = typeof rawCode === "number" || (typeof rawCode === "string" && rawCode.trim())
    ? Number(rawCode)
    : Number.NaN;
  if (!Number.isFinite(code) || !Number.isInteger(code)) {
    throw new Error("malformed Feishu response: missing numeric code");
  }
  return {
    code,
    msg: String(response.msg ?? "").trim(),
    data: jsonObject(response.data),
    log_id: String(response.log_id ?? "").trim(),
  };
};

const fileType = (path: string): "opus" | "mp4" | "pdf" | "doc" | "xls" | "ppt" | "stream" => {
  const extension = extname(path).toLowerCase();
  if (extension === ".mp4") return "mp4";
  if ([".opus", ".ogg", ".mp3", ".wav"].includes(extension)) return "opus";
  if (extension === ".pdf") return "pdf";
  if ([".doc", ".docx"].includes(extension)) return "doc";
  if ([".xls", ".xlsx", ".csv"].includes(extension)) return "xls";
  if ([".ppt", ".pptx"].includes(extension)) return "ppt";
  return "stream";
};

const officialConstructors: Constructors = {
  Client: Lark.Client as unknown as Constructors["Client"],
  EventDispatcher: Lark.EventDispatcher as unknown as Constructors["EventDispatcher"],
  WSClient: Lark.WSClient as unknown as Constructors["WSClient"],
};

const sdkLogger = {
  // Connection lifecycle and terminal API failures are logged by the adapter
  // and Runtime respectively. Suppress the SDK's duplicate Axios diagnostics.
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
};

export function createOfficialFeishuSdk(
  config: FeishuConfig,
  callbacks: FeishuSdkCallbacks,
  constructors: Constructors = officialConstructors,
): FeishuSdkServices {
  const domain = config.domain === "feishu"
    ? Lark.Domain.Feishu
    : config.domain === "lark"
      ? Lark.Domain.Lark
      : config.domain;
  const client = new constructors.Client({
    appId: config.appId,
    appSecret: config.appSecret,
    domain,
    // Runtime owns structured delivery errors; suppress the SDK's raw Axios dumps.
    loggerLevel: Lark.LoggerLevel.fatal,
    logger: sdkLogger,
  }) as LooseClient;
  const handlers = {
    "im.message.receive_v1": callbacks.onMessage,
  };
  const dispatcher = new constructors.EventDispatcher({ loggerLevel: Lark.LoggerLevel.fatal, logger: sdkLogger });
  dispatcher.register(handlers);
  const ws = new constructors.WSClient({
    appId: config.appId,
    appSecret: config.appSecret,
    domain,
    loggerLevel: Lark.LoggerLevel.fatal,
    logger: sdkLogger,
    source: "lxe-agent-bun-gateway",
    handshakeTimeoutMs: 15_000,
    wsConfig: { pingTimeout: 20 },
    onReady: callbacks.onReady,
    onError: callbacks.onError,
    onReconnecting: callbacks.onReconnecting,
    onReconnected: callbacks.onReconnected,
  });

  const api: FeishuSdkServices["api"] = {
    request: async (method, path, options = {}) => {
      try {
        const response = await client.request({
          method,
          url: `/open-apis${path}`,
          ...(options.body ? { data: options.body } : {}),
          ...(options.query ? { params: options.query } : {}),
        });
        return apiResponse(response);
      } catch (cause) {
        throw normalizeFeishuTransportError(method, path, cause, "api_request");
      }
    },
    upload: async (path, kind) => {
      const content = Buffer.from(await readFile(path));
      if (kind === "image") {
        const response = object(await client.im.v1.image.create({
          data: { image_type: "message", image: content },
        }));
        return String(response.image_key ?? object(response.data).image_key ?? "").trim();
      }
      const response = object(await client.im.v1.file.create({
        data: {
          file_type: fileType(path),
          file_name: basename(path),
          file: content,
        },
      }));
      return String(response.file_key ?? object(response.data).file_key ?? "").trim();
    },
  };
  const reactions: FeishuReactionPort = {
    add: async (messageId, emoji) => {
      const response = object(await client.im.v1.messageReaction.create({
        data: { reaction_type: { emoji_type: emoji } },
        path: { message_id: messageId },
      }));
      return String(object(response.data).reaction_id ?? response.reaction_id ?? "").trim();
    },
    remove: async (messageId, reactionId) => {
      await client.im.v1.messageReaction.delete({
        path: { message_id: messageId, reaction_id: reactionId },
      });
    },
  };
  const resources: FeishuInboundResourceApi = {
    download: async (messageId, fileKey, type, signal) => {
      try {
        const response = object(await client.request({
          method: "GET",
          url: `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(fileKey)}`,
          params: { type },
          responseType: "arraybuffer",
          $return_headers: true,
          signal,
        }));
        const headers = object(response.headers);
        const disposition = String(headers["content-disposition"] ?? "").trim();
        const encodedName = disposition.match(/filename\*?=(?:UTF-8'')?["']?([^"';]+)/i)?.[1] ?? "";
        let fileName = encodedName;
        try { fileName = decodeURIComponent(encodedName); } catch { /* Keep the server-provided value. */ }
        const raw = response.data;
        const data = raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayBuffer);
        return {
          data,
          contentType: String(headers["content-type"] ?? "application/octet-stream").trim(),
          fileName,
        };
      } catch (cause) {
        throw normalizeFeishuTransportError(
          "GET",
          `/im/v1/messages/${messageId}/resources/${fileKey}`,
          cause,
          "download_message_resource",
        );
      }
    },
  };
  const invokeCardKit = async (
    operationName: string,
    method: string,
    path: string,
    operation: () => Promise<unknown>,
  ): Promise<JsonObject> => {
    try {
      return apiResponse(await operation());
    } catch (cause) {
      throw normalizeFeishuTransportError(method, path, cause, operationName);
    }
  };
  const cardkit: FeishuCardKitApi = {
    createCardEntity: async (card) => invokeCardKit("create_stream_card", "POST", "/cardkit/v1/cards", () =>
      client.cardkit.v1.card.create({
        data: { type: "card_json", data: JSON.stringify(card) },
      })),
    streamCardContent: async ({ cardId, elementId, content, sequence }) =>
      invokeCardKit("stream_card_content", "PUT", `/cardkit/v1/cards/${cardId}/elements/${elementId}/content`, () =>
        client.cardkit.v1.cardElement.content({
          data: { content, sequence, uuid: `stream_${cardId}_${sequence}` },
          path: { card_id: cardId, element_id: elementId },
        })),
    updateCard: async ({ cardId, card, sequence }) =>
      invokeCardKit("update_card", "PUT", `/cardkit/v1/cards/${cardId}`, () =>
        client.cardkit.v1.card.update({
          data: {
            card: { type: "card_json", data: JSON.stringify(card) },
            sequence,
            uuid: `update_${cardId}_${sequence}`,
          },
          path: { card_id: cardId },
        })),
    setStreamingMode: async ({ cardId, streamingMode, sequence }) =>
      invokeCardKit(streamingMode ? "reopen_streaming_mode" : "close_streaming_mode", "PATCH", `/cardkit/v1/cards/${cardId}/settings`, () =>
        client.cardkit.v1.card.settings({
          data: {
            settings: JSON.stringify({ config: { streaming_mode: streamingMode } }),
            sequence,
            uuid: `${streamingMode ? "reopen" : "close"}_${cardId}_${sequence}`,
          },
          path: { card_id: cardId },
        })),
    sendCardByReference: async ({ conversationId, sourceMessageId, cardId }) => {
      const content = JSON.stringify({ type: "card", data: { card_id: cardId } });
      return sourceMessageId
        ? invokeCardKit("send_stream_card_reply", "POST", `/im/v1/messages/${sourceMessageId}/reply`, () =>
            client.im.v1.message.reply({
              path: { message_id: sourceMessageId },
              data: { msg_type: "interactive", content },
            }))
        : invokeCardKit("send_stream_card", "POST", "/im/v1/messages?receive_id_type=chat_id", () =>
            client.im.v1.message.create({
              params: { receive_id_type: "chat_id" },
              data: { receive_id: conversationId, msg_type: "interactive", content },
            }));
    },
  };
  return {
    api,
    cardkit,
    reactions,
    resources,
    connection: {
      start: async () => { await ws.start({ eventDispatcher: dispatcher }); },
      stop: async (force = false) => { await ws.close({ force }); },
      status: () => jsonObject(ws.getConnectionStatus?.() ?? { state: "unknown" }),
    },
    probeBotIdentity: async () => {
      const response = jsonObject(await client.request({ method: "GET", url: "/open-apis/bot/v3/info" }));
      const envelope = parseFeishuEnvelope(response, "probe_bot_identity");
      if (envelope.code !== 0) {
        throw new FeishuApiResponseError({
          apiCode: envelope.code,
          logId: envelope.logId,
          operation: "probe_bot_identity",
          message: `Feishu probe_bot_identity failed with code ${envelope.code}${envelope.msg ? `: ${envelope.msg}` : ""}`,
        });
      }
      const outer = object(response);
      const payload = object(outer.data ?? outer);
      const bot = object(payload.bot);
      return {
        openId: String(bot.open_id ?? "").trim(),
        name: String(bot.app_name ?? bot.bot_name ?? bot.name ?? "").trim(),
      };
    },
  };
}

export type FeishuSdkFactory = (callbacks: FeishuSdkCallbacks) => FeishuSdkServices;

export const createOfficialFeishuSdkFactory = (config: FeishuConfig): FeishuSdkFactory =>
  (callbacks) => createOfficialFeishuSdk(config, callbacks);
