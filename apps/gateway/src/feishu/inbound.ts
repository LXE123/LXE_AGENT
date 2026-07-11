import { randomUUID } from "node:crypto";
import type { InboundEvent, JsonObject } from "@lxe/protocol";

export interface FeishuMention {
  key: string;
  name: string;
  id: { open_id: string; union_id: string };
}

export interface FeishuMessageSnapshot {
  app_id: string;
  message_type: string;
  content: string;
  chat_type: string;
  chat_id: string;
  thread_id: string;
  root_id: string;
  parent_id: string;
  create_time: string;
  update_time: string;
  message_id: string;
  mentions: FeishuMention[];
  sender_type: string;
  sender_open_id: string;
  sender_user_id: string;
  sender_union_id: string;
}

export interface FeishuInboundResource extends JsonObject {
  type: string;
  file_key: string;
  file_name: string;
}

export interface ResolvedResources {
  userInput: string;
  userContentBlocks: JsonObject[];
  resourceMetadata: JsonObject[];
}

export interface FeishuInboundOptions {
  botOpenId?: string;
  botName?: string;
  appId?: string;
  botIdSource?: string;
  nowMs?: () => number;
  monotonicMs?: () => number;
  uuid?: () => string;
  resolveResources?: (resources: FeishuInboundResource[], snapshot: FeishuMessageSnapshot) => Promise<ResolvedResources>;
  loadQuote?: (parentId: string, chatId: string) => Promise<{ text: string; metadata: JsonObject }>;
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
const text = (value: unknown, fallback = ""): string => String(value ?? fallback).trim();
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

export function snapshotMessageEvent(value: unknown): FeishuMessageSnapshot | null {
  const root = record(value);
  const header = record(root.header);
  const event = Object.keys(record(root.event)).length > 0 ? record(root.event) : root;
  const message = record(event.message);
  if (Object.keys(event).length === 0 || Object.keys(message).length === 0) return null;
  const sender = record(event.sender);
  const senderId = record(sender.sender_id);
  const mentions = array(message.mentions).map((item): FeishuMention => {
    const mention = record(item);
    const id = record(mention.id);
    return {
      key: text(mention.key),
      name: text(mention.name),
      id: { open_id: text(id.open_id), union_id: text(id.union_id) },
    };
  });
  return {
    app_id: text(header.app_id),
    message_type: text(message.message_type, "text") || "text",
    content: String(message.content ?? "{}"),
    chat_type: text(message.chat_type, "p2p") || "p2p",
    chat_id: text(message.chat_id),
    thread_id: text(message.thread_id),
    root_id: text(message.root_id),
    parent_id: text(message.parent_id),
    create_time: text(message.create_time),
    update_time: text(message.update_time),
    message_id: text(message.message_id),
    mentions,
    sender_type: text(sender.sender_type),
    sender_open_id: text(senderId.open_id),
    sender_user_id: text(senderId.user_id),
    sender_union_id: text(senderId.union_id),
  };
}

const parseJson = (content: string): unknown => {
  try {
    return JSON.parse(content);
  } catch {
    return {};
  }
};

const postText = (value: unknown): string => {
  const root = record(value);
  const locale = record(root.zh_cn ?? root.en_us ?? Object.values(root)[0]);
  const lines: string[] = [];
  const title = text(locale.title);
  if (title) lines.push(title);
  for (const row of array(locale.content)) {
    const line = array(row).map((node) => {
      const item = record(node);
      if (text(item.tag) === "a") return text(item.text) || text(item.href);
      return text(item.text);
    }).filter(Boolean).join("");
    if (line) lines.push(line);
  }
  return lines.join("\n").trim();
};

export interface FeishuInboundConversion {
  message: string;
  resources: FeishuInboundResource[];
}

export type FeishuMessageConverter = (content: Record<string, unknown>, snapshot: FeishuMessageSnapshot) => FeishuInboundConversion;

const none = (message: string): FeishuInboundConversion => ({ message: message.trim(), resources: [] });
const readableJson = (value: unknown): string => JSON.stringify(value, null, 2).slice(0, 4_000);
const firstText = (value: unknown): string => {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map(firstText).filter(Boolean).join("\n");
  const item = record(value);
  return text(item.text) || text(item.title) || text(item.name) || text(item.summary) || text(item.content);
};

const converters: Readonly<Record<string, FeishuMessageConverter>> = {
  text: (content) => none(text(content.text)),
  post: (content) => none(postText(content)),
  image: (content) => {
    const key = text(content.image_key);
    return { message: "", resources: key ? [{ type: "image", file_key: key, file_name: "" }] : [] };
  },
  file: (content) => {
    const key = text(content.file_key);
    return { message: "", resources: key ? [{ type: "file", file_key: key, file_name: text(content.file_name) }] : [] };
  },
  audio: (content) => {
    const key = text(content.file_key);
    return { message: "[Audio message]", resources: key ? [{ type: "audio", file_key: key, file_name: text(content.file_name) }] : [] };
  },
  video: (content) => {
    const key = text(content.file_key);
    const imageKey = text(content.image_key);
    return {
      message: "[Video message]",
      resources: [
        ...(key ? [{ type: "video", file_key: key, file_name: text(content.file_name) }] : []),
        ...(imageKey ? [{ type: "image", file_key: imageKey, file_name: "video-cover" }] : []),
      ],
    };
  },
  location: (content) => none([
    `[Location] ${text(content.name) || text(content.address) || "Shared location"}`,
    text(content.address),
    text(content.latitude) && text(content.longitude) ? `${text(content.latitude)}, ${text(content.longitude)}` : "",
  ].filter(Boolean).join("\n")),
  sticker: (content) => {
    const key = text(content.file_key) || text(content.image_key);
    return { message: "[Sticker]", resources: key ? [{ type: "image", file_key: key, file_name: "sticker" }] : [] };
  },
  calendar: (content) => none([
    `[Calendar] ${firstText(content.summary) || firstText(content.title) || "Shared event"}`,
    text(content.start_time), text(content.end_time), text(content.event_id),
  ].filter(Boolean).join("\n")),
  share_chat: (content) => none(`[Shared chat] ${text(content.chat_name) || text(content.chat_id) || "Unknown chat"}`),
  share_user: (content) => none(`[Shared contact] ${text(content.user_name) || text(content.user_id) || "Unknown user"}`),
  share: (content) => none(`[Shared item] ${firstText(content) || readableJson(content)}`),
  folder: (content) => {
    const key = text(content.file_key);
    return {
      message: `[Shared folder] ${text(content.file_name) || text(content.name) || key || "Unknown folder"}`,
      resources: key ? [{ type: "folder", file_key: key, file_name: text(content.file_name) || text(content.name) }] : [],
    };
  },
  todo: (content) => none([
    `[Todo] ${firstText(content.summary) || firstText(content.title) || "Shared task"}`,
    text(content.due_time), text(content.task_id) || text(content.todo_id),
  ].filter(Boolean).join("\n")),
  vote: (content) => none([
    `[Vote] ${firstText(content.topic) || firstText(content.title) || "Shared vote"}`,
    ...array(content.options).map(firstText).filter(Boolean),
  ].join("\n")),
  video_chat: (content) => none([
    `[Video meeting] ${firstText(content.topic) || firstText(content.title) || "Shared meeting"}`,
    text(content.start_time), text(content.meeting_id),
  ].filter(Boolean).join("\n")),
  merge_forward: (content) => none([
    `[Merged forward] ${firstText(content.title)}`.trim(),
    ...array(content.messages).map((item) => {
      const message = record(item);
      const nestedType = text(message.message_type, "unknown") || "unknown";
      const nestedContent = record(typeof message.content === "string" ? parseJson(message.content) : message.content);
      const converted = converters[nestedType]?.(nestedContent, {} as FeishuMessageSnapshot);
      return converted?.message || firstText(nestedContent) || `[${nestedType}]`;
    }),
  ].filter(Boolean).join("\n\n")),
  interactive: (content) => none(`[Interactive card]\n${firstText(content) || readableJson(content)}`),
  system: (content) => none(`[System message] ${firstText(content) || readableJson(content)}`),
};

export const FEISHU_CONVERTER_TYPES = Object.freeze(Object.keys(converters));

export const convertFeishuMessage = (snapshot: FeishuMessageSnapshot): FeishuInboundConversion => {
  const parsed = record(parseJson(snapshot.content));
  const converter = converters[snapshot.message_type];
  if (converter) return converter(parsed, snapshot);
  const fallback = firstText(parsed);
  return none(`[Unsupported Feishu message: ${snapshot.message_type}]${fallback ? `\n${fallback}` : ""}`);
};

const mentionOpenId = (mention: FeishuMention): string => text(mention.id?.open_id);

const stripBotMention = (value: string, mentions: FeishuMention[], botOpenId: string): string => {
  let result = value;
  for (const mention of mentions) {
    if (mentionOpenId(mention) !== botOpenId) continue;
    if (mention.name) result = result.replaceAll(`@${mention.name}`, " ");
    if (mention.key) result = result.replaceAll(mention.key, " ");
  }
  return result.split(/\s+/u).filter(Boolean).join(" ");
};

export class FeishuInboundNormalizer {
  private readonly seen = new Map<string, number>();
  private readonly nowMs: () => number;
  private readonly monotonicMs: () => number;
  private readonly uuid: () => string;

  constructor(private readonly options: FeishuInboundOptions = {}) {
    this.nowMs = options.nowMs ?? Date.now;
    this.monotonicMs = options.monotonicMs ?? (() => performance.now());
    this.uuid = options.uuid ?? (() => randomUUID().replaceAll("-", ""));
  }

  async normalize(snapshot: FeishuMessageSnapshot): Promise<InboundEvent | null> {
    if (!this.accept(snapshot)) return null;
    const botOpenId = text(this.options.botOpenId);
    const mentions = snapshot.mentions;
    let { message, resources } = convertFeishuMessage(snapshot);
    if (snapshot.chat_type === "group") {
      if (!botOpenId || !mentions.some((item) => mentionOpenId(item) === botOpenId)) return null;
      message = stripBotMention(message, mentions, botOpenId);
    }
    const userId = text(snapshot.sender_open_id);
    if (!userId) return null;
    let blocks: JsonObject[] = [];
    let resourceMetadata: JsonObject[] = [];
    if (resources.length > 0) {
      const resolved = this.options.resolveResources
        ? await this.options.resolveResources(resources, snapshot)
        : {
            userInput: resources.map((item) => `[${item.type}:${item.file_name || item.file_key}]`).join("\n"),
            userContentBlocks: resources.map((item) => ({ ...item })),
            resourceMetadata: resources.map((item) => ({ ...item })),
          };
      message = [message, resolved.userInput].map((item) => item.trim()).filter(Boolean).join("\n");
      blocks = resolved.userContentBlocks.map((item) => ({ ...item }));
      resourceMetadata = resolved.resourceMetadata.map((item) => ({ ...item }));
    }
    let quotedMessage: JsonObject | undefined;
    if (snapshot.parent_id && this.options.loadQuote) {
      const quote = await this.options.loadQuote(snapshot.parent_id, snapshot.chat_id);
      quotedMessage = { ...quote.metadata };
      if (quote.text.trim()) message = `${quote.text.trim()}\n\n${message}`.trim();
    }
    if (!message && blocks.length === 0) return null;

    const unionId = text(snapshot.sender_union_id);
    const senderNick = text(snapshot.sender_user_id) || unionId || userId;
    const appId = text(snapshot.app_id) || text(this.options.appId);
    const sourceExtra = this.nonEmpty({
      bot_app_id: appId,
      bot_id: botOpenId,
      bot_name: text(this.options.botName),
      bot_id_source: text(this.options.botIdSource, "configured") || "configured",
      message_type: snapshot.message_type,
      sender_type: snapshot.sender_type,
    });
    const source: JsonObject = {
      platform: "feishu",
      chat_id: snapshot.chat_id,
      chat_type: snapshot.chat_type,
      user_id: userId,
      user_id_alt: unionId,
      user_name: senderNick,
      thread_id: snapshot.thread_id,
      message_id: snapshot.message_id,
      root_id: snapshot.root_id,
      parent_id: snapshot.parent_id,
      extra: sourceExtra,
    };
    const rawData: JsonObject = {
      platform: "feishu",
      app_id: appId,
      chat_id: snapshot.chat_id,
      chat_type: snapshot.chat_type,
      thread_id: snapshot.thread_id,
      root_id: snapshot.root_id,
      parent_id: snapshot.parent_id,
      create_time: snapshot.create_time,
      update_time: snapshot.update_time,
      message_id: snapshot.message_id,
      message_type: snapshot.message_type,
      sender_type: snapshot.sender_type,
      open_id: userId,
      sender_open_id: userId,
      sender_user_id: snapshot.sender_user_id,
      sender_union_id: unionId,
      union_id: unionId,
      source,
      resources: resourceMetadata,
    };
    if (quotedMessage) rawData.quoted_message = quotedMessage;
    return {
      platform: "feishu",
      event_type: "agent_message",
      user_input: message,
      user_id: userId,
      response_route_id: this.uuid(),
      conversation_id: snapshot.chat_id,
      is_group: snapshot.chat_type === "group",
      message_id: snapshot.message_id,
      sender_nick: senderNick,
      union_id: unionId,
      source,
      raw_data: rawData,
      user_content_blocks: blocks,
    };
  }

  private accept(snapshot: FeishuMessageSnapshot): boolean {
    const messageId = snapshot.message_id;
    const now = this.monotonicMs();
    const cutoff = now - 12 * 60 * 60 * 1000;
    for (const [id, recordedAt] of this.seen) if (recordedAt < cutoff) this.seen.delete(id);
    if (messageId && this.seen.has(messageId)) return false;
    if (messageId) this.seen.set(messageId, now);
    if (!snapshot.create_time) return true;
    if (!/^\d+$/u.test(snapshot.create_time)) return true;
    const createdAt = Number(snapshot.create_time);
    if (!Number.isFinite(createdAt)) return true;
    return this.nowMs() - createdAt <= 5 * 60 * 1000;
  }

  private nonEmpty(values: Record<string, string>): JsonObject {
    return Object.fromEntries(Object.entries(values).filter(([, value]) => value.trim())) as JsonObject;
  }
}
