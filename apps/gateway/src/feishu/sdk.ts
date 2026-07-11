import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import * as Lark from "@larksuiteoapi/node-sdk";
import type { JsonObject } from "@lxe/protocol";
import type { FeishuApiPort } from "./cardkit";
import type { FeishuConfig } from "./config";
import type { FeishuMediaApi } from "./media";
import type { FeishuReactionPort } from "./typing";

export const FEISHU_EVENT_TYPES = [
  "im.message.receive_v1",
  "im.message.reaction.created_v1",
  "im.message.reaction.deleted_v1",
] as const;

export interface FeishuSdkCallbacks {
  onMessage(data: unknown): Promise<void> | void;
  onReactionCreated(data: unknown): Promise<void> | void;
  onReactionDeleted(data: unknown): Promise<void> | void;
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
  api: FeishuApiPort & FeishuMediaApi;
  reactions: FeishuReactionPort;
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
  im: { v1: {
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
    loggerLevel: Lark.LoggerLevel.info,
  }) as LooseClient;
  const handlers = {
    "im.message.receive_v1": callbacks.onMessage,
    "im.message.reaction.created_v1": callbacks.onReactionCreated,
    "im.message.reaction.deleted_v1": callbacks.onReactionDeleted,
  };
  const dispatcher = new constructors.EventDispatcher({ loggerLevel: Lark.LoggerLevel.info });
  dispatcher.register(handlers);
  const ws = new constructors.WSClient({
    appId: config.appId,
    appSecret: config.appSecret,
    domain,
    loggerLevel: Lark.LoggerLevel.info,
    source: "lxe-agent-bun-gateway",
    handshakeTimeoutMs: 15_000,
    wsConfig: { pingTimeout: 20 },
    onReady: callbacks.onReady,
    onError: callbacks.onError,
    onReconnecting: callbacks.onReconnecting,
    onReconnected: callbacks.onReconnected,
  });

  const api: FeishuSdkServices["api"] = {
    request: async (method, path, body) => {
      const response = await client.request({
        method,
        url: `/open-apis${path}`,
        data: body,
      });
      const outer = object(response);
      return jsonObject(outer.data ?? outer);
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
  return {
    api,
    reactions,
    connection: {
      start: async () => { await ws.start({ eventDispatcher: dispatcher }); },
      stop: async (force = false) => { await ws.close({ force }); },
      status: () => jsonObject(ws.getConnectionStatus?.() ?? { state: "unknown" }),
    },
    probeBotIdentity: async () => {
      const response = await client.request({ method: "GET", url: "/open-apis/bot/v3/info" });
      const outer = object(response);
      const payload = object(outer.data ?? outer);
      const bot = object(payload.bot);
      return {
        openId: String(bot.open_id ?? "").trim(),
        name: String(bot.bot_name ?? bot.name ?? "").trim(),
      };
    },
  };
}

export type FeishuSdkFactory = (callbacks: FeishuSdkCallbacks) => FeishuSdkServices;

export const createOfficialFeishuSdkFactory = (config: FeishuConfig): FeishuSdkFactory =>
  (callbacks) => createOfficialFeishuSdk(config, callbacks);
