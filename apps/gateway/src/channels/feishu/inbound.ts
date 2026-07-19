import { randomUUID } from "node:crypto";
import type { AgentDiagnostic, InboundEvent, JsonObject } from "@lxe/protocol";
import { createFeishuDiagnostic } from "./response";

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
  message_id?: string;
}

export interface ResolvedResources {
  userInput: string;
  userContentBlocks: JsonObject[];
  resourceMetadata: JsonObject[];
  diagnostics: AgentDiagnostic[];
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
  converterContext?: FeishuMessageConverterContext;
  loadQuote?: (parentId: string, chatId: string) => Promise<{
    text: string;
    metadata: JsonObject;
    userContentBlocks?: JsonObject[];
    resourceMetadata?: JsonObject[];
    diagnostics?: AgentDiagnostic[];
  }>;
}

export type FeishuInboundRejectReason =
  | "duplicate"
  | "stale"
  | "group_bot_identity_missing"
  | "group_without_bot_mention"
  | "missing_sender_open_id"
  | "empty_content";

export type FeishuNormalizeDecision =
  | { accepted: true; event: InboundEvent }
  | { accepted: false; reason: FeishuInboundRejectReason; metadata: JsonObject };

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

export interface FeishuInboundConversion {
  message: string;
  resources: FeishuInboundResource[];
  diagnostics: AgentDiagnostic[];
}

export interface FeishuMessageConverterContext {
  resolveResources?: (resources: FeishuInboundResource[], snapshot: FeishuMessageSnapshot) => Promise<ResolvedResources>;
  fetchSubMessages?: (messageId: string) => Promise<Record<string, unknown>[]>;
  fetchInteractiveContent?: (messageId: string) => Promise<string | undefined>;
  resolveUserName?: (userId: string) => string | undefined | Promise<string | undefined>;
  maxDepth?: number;
}

export type FeishuMessageConverter = (
  content: Record<string, unknown>,
  snapshot: FeishuMessageSnapshot,
  context: FeishuMessageConverterContext,
  depth: number,
) => Promise<FeishuInboundConversion>;

const none = (message: string, diagnostics: AgentDiagnostic[] = []): FeishuInboundConversion => ({
  message: message.trim(),
  resources: [],
  diagnostics,
});
const readableJson = (value: unknown): string => JSON.stringify(value, null, 2).slice(0, 4_000);
const firstText = (value: unknown): string => {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map(firstText).filter(Boolean).join("\n");
  const item = record(value);
  return text(item.text) || text(item.title) || text(item.name) || text(item.summary) || text(item.content);
};

const resource = (
  snapshot: FeishuMessageSnapshot,
  type: string,
  fileKey: string,
  fileName = "",
): FeishuInboundResource => ({
  type,
  file_key: fileKey,
  file_name: fileName,
  ...(snapshot.message_id ? { message_id: snapshot.message_id } : {}),
});

const applyStyle = (value: string, styles: unknown[]): string => {
  const names = new Set(styles.map((style) => text(style)));
  let result = value;
  if (names.has("bold")) result = `**${result}**`;
  if (names.has("italic")) result = `*${result}*`;
  if (names.has("lineThrough")) result = `~~${result}~~`;
  if (names.has("codeInline")) result = `\`${result}\``;
  return result;
};

const mentionName = async (
  item: Record<string, unknown>,
  snapshot: FeishuMessageSnapshot,
  context: FeishuMessageConverterContext,
): Promise<string> => {
  const userId = text(item.user_id);
  if (userId === "all") return "@all";
  const mention = snapshot.mentions.find((candidate) =>
    candidate.id.open_id === userId || candidate.key === text(item.key));
  if (mention) return mention.key || `@${mention.name || mention.id.open_id}`;
  const resolved = userId && context.resolveUserName ? await context.resolveUserName(userId) : undefined;
  return resolved ? `@${resolved}` : text(item.user_name) ? `@${text(item.user_name)}` : userId ? `@${userId}` : "";
};

const convertPost = async (
  content: Record<string, unknown>,
  snapshot: FeishuMessageSnapshot,
  context: FeishuMessageConverterContext,
): Promise<FeishuInboundConversion> => {
  const locale = record(content.title !== undefined || content.content !== undefined
    ? content
    : content.zh_cn ?? content.en_us ?? content.ja_jp ?? Object.values(content)[0]);
  const resources: FeishuInboundResource[] = [];
  const lines: string[] = [];
  const title = text(locale.title);
  if (title) lines.push(`**${title}**`, "");
  for (const row of array(locale.content)) {
    const parts: string[] = [];
    for (const node of array(row)) {
      const item = record(node);
      const tag = text(item.tag).toLowerCase();
      if (tag === "text") parts.push(applyStyle(String(item.text ?? ""), array(item.style)));
      else if (tag === "md") parts.push(String(item.text ?? ""));
      else if (tag === "a") {
        const href = text(item.href);
        const label = text(item.text) || href;
        parts.push(href && label !== href ? `[${label}](${href})` : label);
      } else if (tag === "at") parts.push(await mentionName(item, snapshot, context));
      else if (tag === "img") {
        const key = text(item.image_key);
        if (key) {
          resources.push(resource(snapshot, "image", key));
          parts.push(`![image](${key})`);
        }
      } else if (tag === "media" || tag === "file") {
        const key = text(item.file_key);
        const name = text(item.file_name) || text(item.title) || text(item.text);
        if (key) {
          resources.push(resource(snapshot, "file", key, name));
          parts.push(`<file key="${key}"${name ? ` name="${name}"` : ""}/>`);
        }
      } else if (tag === "code_block") {
        parts.push(`\n\`\`\`${text(item.language)}\n${String(item.text ?? "")}\n\`\`\`\n`);
      } else if (tag === "hr") parts.push("\n---\n");
      else parts.push(String(item.text ?? ""));
    }
    const line = parts.join("").trim();
    if (line) lines.push(line);
  }
  return { message: lines.join("\n").trim() || (resources.length ? "" : "[rich text message]"), resources, diagnostics: [] };
};

const DEFAULT_CARD_FALLBACK = "请升级至最新版本客户端，以查看内容";

const cardText = (value: unknown): string => {
  if (typeof value === "string") return value.trim();
  const item = record(value);
  const property = record(item.property);
  const localized = record(property.i18nContent ?? property.i18n_content ?? item.i18nContent ?? item.i18n_content);
  for (const locale of ["zh_cn", "en_us", "ja_jp"]) {
    const result = firstText(localized[locale]);
    if (result) return result;
  }
  for (const candidate of [property.content, item.content, property.text, item.text, property.title, item.title,
    property.value, item.value, property.label, item.label, property.placeholder, item.placeholder, property.name, item.name]) {
    const nested = record(candidate);
    const scalar = typeof candidate === "string" || typeof candidate === "number"
      ? candidate
      : nested.content ?? nested.text ?? nested.title ?? nested.value ?? nested.label ?? nested.name;
    const result = text(scalar);
    if (result) return result;
  }
  return "";
};

const cardCodeText = (value: unknown): string => {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(cardCodeText).join("");
  const item = record(value);
  const property = record(item.property);
  const direct = property.content ?? item.content ?? property.text ?? item.text;
  if (typeof direct === "string" || typeof direct === "number") return String(direct);
  for (const nested of [property.contents, item.contents, property.elements, item.elements]) {
    const result = cardCodeText(nested);
    if (result) return result;
  }
  return "";
};

const CARD_RENDER_MAX_DEPTH = 64;
const CARD_RENDER_MAX_NODES = 2_000;
const CARD_RENDER_MAX_CHARS = 64_000;

interface CardRenderState {
  nodes: number;
}

const renderInteractive = (
  value: unknown,
  rawCard: boolean,
  state: CardRenderState,
  depth = 0,
): string[] => {
  if (depth > CARD_RENDER_MAX_DEPTH) throw new RangeError(`Feishu card exceeds maximum render depth ${CARD_RENDER_MAX_DEPTH}`);
  state.nodes += 1;
  if (state.nodes > CARD_RENDER_MAX_NODES) throw new RangeError(`Feishu card exceeds maximum render nodes ${CARD_RENDER_MAX_NODES}`);
  if (Array.isArray(value)) return value.flatMap((item) => renderInteractive(item, rawCard, state, depth + 1));
  if (typeof value === "string") {
    const result = value.trim();
    return result && result !== DEFAULT_CARD_FALLBACK ? [result] : [];
  }
  const item = record(value);
  if (Object.keys(item).length === 0) return [];
  const property = record(item.property);
  const tag = text(item.tag).toLowerCase();
  if (["custom_icon", "standard_icon", "card_header"].includes(tag)) return [];
  if (tag === "fallback_text") {
    const fallback = cardText(item);
    return fallback && fallback !== DEFAULT_CARD_FALLBACK ? [fallback] : [];
  }
  if (["img", "image", "avatar"].includes(tag)) {
    if (!rawCard) return [];
    const alt = cardText(item.alt) || cardText(property.alt) || cardText(item.title) || cardText(property.title);
    return [alt ? `[Card image: ${alt}]` : "[Card image]"];
  }
  if (tag === "button") {
    const label = cardText(item.text) || cardText(property.text) || cardText(item);
    return [label ? `[button] ${label}` : "[button]"];
  }
  if (["link", "a"].includes(tag)) {
    const label = cardText(item.text) || cardText(property.text) || cardText(item.title);
    const href = text(item.href) || text(property.href) || text(item.url) || text(property.url);
    return [label && href ? `[${label}](${href})` : label || href].filter(Boolean);
  }
  if (["at", "person", "person_v1"].includes(tag)) {
    const name = cardText(item.name) || cardText(property.name) || text(property.user_id);
    return name ? [`@${name}`] : [];
  }
  if (tag === "at_all") return ["@all"];
  if (tag === "heading") return cardText(item) ? [`### ${cardText(item)}`] : [];
  if (tag === "blockquote") return cardText(item) ? [`> ${cardText(item)}`] : [];
  if (["code_block", "code_span"].includes(tag)) {
    const code = cardCodeText(property.contents ?? item.contents ?? item).trim();
    const language = text(property.language) || text(item.language);
    return code ? [tag === "code_span" ? `\`${code}\`` : `\`\`\`${language}\n${code}\n\`\`\``] : [];
  }
  const lines: string[] = [];
  const own = cardText(item);
  if (own && own !== DEFAULT_CARD_FALLBACK) lines.push(own);
  for (const child of [item.title, item.subtitle, item.text, item.header, item.body, item.elements, item.columns, item.actions, item.items, item.fields,
    item.contents, item.footer, property.title, property.subtitle, property.text, property.header, property.body, property.elements, property.columns,
    property.actions, property.items, property.fields, property.contents, property.footer]) {
    lines.push(...renderInteractive(child, rawCard, state, depth + 1));
  }
  return lines.filter((line, index, all) => line && all.indexOf(line) === index);
};

const parseInteractiveCard = (value: Record<string, unknown>): { card: Record<string, unknown>; raw: boolean } => {
  if (typeof value.json_card !== "string") return { card: value, raw: false };
  try {
    const parsed = JSON.parse(value.json_card);
    const card = record(parsed);
    if (Object.keys(card).length === 0) throw new TypeError("Feishu raw card JSON must contain an object");
    return { card, raw: true };
  } catch (cause) {
    if (cause instanceof TypeError && cause.message === "Feishu raw card JSON must contain an object") throw cause;
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new SyntaxError(`Failed to parse Feishu raw card JSON: ${detail}`);
  }
};

const convertInteractive = async (
  content: Record<string, unknown>,
  snapshot: FeishuMessageSnapshot,
  context: FeishuMessageConverterContext,
): Promise<FeishuInboundConversion> => {
  const candidates: Record<string, unknown>[] = [];
  const diagnostics: AgentDiagnostic[] = [];
  if (typeof content.json_card !== "string" && snapshot.message_id && context.fetchInteractiveContent) {
    try {
      const fetched = await context.fetchInteractiveContent(snapshot.message_id);
      if (fetched) candidates.push(record(parseJson(fetched)));
    } catch (cause) {
      diagnostics.push(createFeishuDiagnostic(cause, {
        operation: "interactive_card_read",
        stage: "raw_card_fetch",
      }));
    }
  }
  candidates.push(content);
  for (const candidate of candidates) {
    try {
      const parsed = parseInteractiveCard(candidate);
      const state: CardRenderState = { nodes: 0 };
      const lines = renderInteractive(parsed.card, parsed.raw, state)
        .filter((line, index, all) => line && all.indexOf(line) === index);
      const rendered = lines.join("\n");
      if (!rendered.trim()) throw new Error("Feishu interactive card contains no readable text");
      if (rendered.length > CARD_RENDER_MAX_CHARS) {
        throw new RangeError(`Feishu card rendered text exceeds maximum length ${CARD_RENDER_MAX_CHARS}`);
      }
      return none(`[Interactive card]\n${rendered}`);
    } catch (cause) {
      diagnostics.push(createFeishuDiagnostic(cause, {
        operation: "interactive_card_read",
        stage: cause instanceof SyntaxError ? "raw_card_parse" : "card_convert",
        ...(cause instanceof Error && cause.message === "Feishu interactive card contains no readable text"
          ? {
              causeKnown: true,
              verifiedReason: "interactive_card_has_no_readable_text",
              mappingId: "local:interactive_card_has_no_readable_text:v1",
            }
          : {}),
      }));
    }
  }
  return none("", diagnostics);
};

const itemSnapshot = (item: Record<string, unknown>, parent: FeishuMessageSnapshot): FeishuMessageSnapshot => {
  const sender = record(item.sender);
  const body = record(item.body);
  return {
    ...parent,
    message_type: text(item.msg_type) || text(item.message_type) || "unknown",
    content: typeof item.content === "string" ? item.content : String(body.content ?? "{}"),
    message_id: text(item.message_id),
    parent_id: text(item.upper_message_id),
    create_time: text(item.create_time),
    sender_type: text(sender.sender_type),
    sender_open_id: text(sender.id) || text(sender.open_id),
    sender_user_id: text(sender.user_id),
    sender_union_id: text(sender.union_id),
    mentions: array(item.mentions).map((raw): FeishuMention => {
      const mention = record(raw);
      const id = record(mention.id);
      return { key: text(mention.key), name: text(mention.name), id: { open_id: text(id.open_id) || text(mention.open_id), union_id: text(id.union_id) } };
    }),
  };
};

const formattedTimestamp = (value: string): string => {
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return "unknown";
  return new Date(milliseconds).toLocaleString("sv-SE", { hour12: false });
};

const convertMerged = async (
  content: Record<string, unknown>,
  snapshot: FeishuMessageSnapshot,
  context: FeishuMessageConverterContext,
  depth: number,
): Promise<FeishuInboundConversion> => {
  if (depth >= Math.max(1, context.maxDepth ?? 8)) {
    const cause = new RangeError(`Feishu forwarded message exceeds maximum depth ${Math.max(1, context.maxDepth ?? 8)}`);
    return none("", [createFeishuDiagnostic(cause, {
      operation: "merge_forward_read",
      stage: "message_convert",
      causeKnown: true,
      verifiedReason: "merge_forward_depth_limit_reached",
      mappingId: "local:merge_forward_depth_limit_reached:v1",
    })]);
  }
  let items = array(content.messages).map(record);
  if (items.length === 0 && context.fetchSubMessages) {
    try {
      items = (await context.fetchSubMessages(snapshot.message_id)).map(record);
    } catch (cause) {
      return none("", [createFeishuDiagnostic(cause, {
        operation: "merge_forward_read",
        stage: "submessage_fetch",
      })]);
    }
  }
  if (items.length === 0) {
    const cause = new Error("Feishu forwarded message lookup returned no items");
    return none("", [createFeishuDiagnostic(cause, {
      operation: "merge_forward_read",
      stage: "submessage_lookup",
      causeKnown: true,
      verifiedReason: "merge_forward_lookup_returned_no_items",
      mappingId: "local:merge_forward_lookup_returned_no_items:v1",
    })]);
  }
  const children = new Map<string, Record<string, unknown>[]>();
  for (const item of items) {
    const messageId = text(item.message_id);
    const upper = text(item.upper_message_id);
    if (messageId === snapshot.message_id && !upper) continue;
    const parentId = upper || snapshot.message_id;
    const bucket = children.get(parentId) ?? [];
    bucket.push(item);
    children.set(parentId, bucket);
  }
  for (const bucket of children.values()) bucket.sort((left, right) => Number(left.create_time ?? 0) - Number(right.create_time ?? 0));
  const resources: FeishuInboundResource[] = [];
  const diagnostics: AgentDiagnostic[] = [];
  const formatTree = async (parentId: string, level: number): Promise<string> => {
    const parts: string[] = [];
    for (const item of children.get(parentId) ?? []) {
      const child = itemSnapshot(item, snapshot);
      const sender = record(item.sender);
      const senderId = text(sender.id) || text(sender.open_id) || child.sender_open_id || "unknown";
      const resolved = context.resolveUserName ? await context.resolveUserName(senderId) : undefined;
      const senderName = text(sender.name) || resolved || senderId;
      let converted: FeishuInboundConversion;
      if (child.message_type === "merge_forward" && child.message_id && children.has(child.message_id)) {
        converted = { message: await formatTree(child.message_id, level + 1), resources: [], diagnostics: [] };
      } else {
        converted = await convertFeishuMessage(child, context, depth + 1);
      }
      resources.push(...converted.resources);
      diagnostics.push(...converted.diagnostics);
      const nested = child.message_type !== "merge_forward" && child.message_id && children.has(child.message_id)
        ? await formatTree(child.message_id, level + 1)
        : "";
      const body = [converted.message || "[empty]", nested].filter(Boolean).join("\n");
      const indent = "    ".repeat(level + 1);
      parts.push(`[${formattedTimestamp(child.create_time)}] ${senderName}:\n${body.split(/\r?\n/u).map((line) => `${indent}${line}`).join("\n")}`);
    }
    return parts.join("\n");
  };
  const body = await formatTree(snapshot.message_id, 0);
  const title = firstText(content.title);
  return {
    message: `<forwarded_messages${title ? ` title="${title}"` : ""}>\n${body}\n</forwarded_messages>`,
    resources,
    diagnostics,
  };
};

const converters: Readonly<Record<string, FeishuMessageConverter>> = {
  text: async (content) => none(text(content.text)),
  post: convertPost,
  image: async (content, snapshot) => {
    const key = text(content.image_key);
    return { message: "", resources: key ? [resource(snapshot, "image", key)] : [], diagnostics: [] };
  },
  file: async (content, snapshot) => {
    const key = text(content.file_key);
    return { message: "", resources: key ? [resource(snapshot, "file", key, text(content.file_name))] : [], diagnostics: [] };
  },
  audio: async (content, snapshot) => {
    const key = text(content.file_key);
    return { message: "[Audio message]", resources: key ? [resource(snapshot, "audio", key, text(content.file_name))] : [], diagnostics: [] };
  },
  video: async (content, snapshot) => {
    const key = text(content.file_key);
    const imageKey = text(content.image_key);
    return {
      message: "[Video message]",
      resources: [
        ...(key ? [resource(snapshot, "video", key, text(content.file_name))] : []),
        ...(imageKey ? [resource(snapshot, "image", imageKey, "video-cover")] : []),
      ],
      diagnostics: [],
    };
  },
  location: async (content) => none([
    `[Location] ${text(content.name) || text(content.address) || "Shared location"}`,
    text(content.address),
    text(content.latitude) && text(content.longitude) ? `${text(content.latitude)}, ${text(content.longitude)}` : "",
  ].filter(Boolean).join("\n")),
  sticker: async (content, snapshot) => {
    const key = text(content.file_key) || text(content.image_key);
    return { message: "[Sticker]", resources: key ? [resource(snapshot, "image", key, "sticker")] : [], diagnostics: [] };
  },
  calendar: async (content) => none([
    `[Calendar] ${firstText(content.summary) || firstText(content.title) || "Shared event"}`,
    text(content.start_time), text(content.end_time), text(content.event_id),
  ].filter(Boolean).join("\n")),
  share_chat: async (content) => none(`[Shared chat] ${text(content.chat_name) || text(content.chat_id) || "Unknown chat"}`),
  share_user: async (content) => none(`[Shared contact] ${text(content.user_name) || text(content.user_id) || "Unknown user"}`),
  share: async (content) => none(`[Shared item] ${firstText(content) || readableJson(content)}`),
  folder: async (content, snapshot) => {
    const key = text(content.file_key);
    return {
      message: `[Shared folder] ${text(content.file_name) || text(content.name) || key || "Unknown folder"}`,
      resources: key ? [resource(snapshot, "folder", key, text(content.file_name) || text(content.name))] : [],
      diagnostics: [],
    };
  },
  todo: async (content) => none([
    `[Todo] ${firstText(content.summary) || firstText(content.title) || "Shared task"}`,
    text(content.due_time), text(content.task_id) || text(content.todo_id),
  ].filter(Boolean).join("\n")),
  vote: async (content) => none([
    `[Vote] ${firstText(content.topic) || firstText(content.title) || "Shared vote"}`,
    ...array(content.options).map(firstText).filter(Boolean),
  ].join("\n")),
  video_chat: async (content) => none([
    `[Video meeting] ${firstText(content.topic) || firstText(content.title) || "Shared meeting"}`,
    text(content.start_time), text(content.meeting_id),
  ].filter(Boolean).join("\n")),
  merge_forward: convertMerged,
  interactive: convertInteractive,
  system: async (content) => none(`[System message] ${firstText(content) || readableJson(content)}`),
};

export const FEISHU_CONVERTER_TYPES = Object.freeze(Object.keys(converters));

export const convertFeishuMessage = async (
  snapshot: FeishuMessageSnapshot,
  context: FeishuMessageConverterContext = {},
  depth = 0,
): Promise<FeishuInboundConversion> => {
  let parsed: Record<string, unknown>;
  if (snapshot.message_type === "interactive") {
    try {
      parsed = record(JSON.parse(snapshot.content));
    } catch (cause) {
      return none("", [createFeishuDiagnostic(cause, {
        operation: "interactive_card_read",
        stage: "raw_card_parse",
      })]);
    }
  } else {
    parsed = record(parseJson(snapshot.content));
  }
  const converter = converters[snapshot.message_type];
  if (converter) return converter(parsed, snapshot, context, depth);
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

  async normalize(snapshot: FeishuMessageSnapshot): Promise<FeishuNormalizeDecision> {
    const rejected = this.rejectionReason(snapshot);
    if (rejected) return this.rejected(snapshot, rejected);
    const botOpenId = text(this.options.botOpenId);
    const mentions = snapshot.mentions;
    let { message, resources, diagnostics } = await convertFeishuMessage(snapshot, this.options.converterContext);
    if (snapshot.chat_type === "group") {
      if (!botOpenId) return this.rejected(snapshot, "group_bot_identity_missing");
      if (!mentions.some((item) => mentionOpenId(item) === botOpenId)) return this.rejected(snapshot, "group_without_bot_mention");
      message = stripBotMention(message, mentions, botOpenId);
    }
    const userId = text(snapshot.sender_open_id);
    if (!userId) return this.rejected(snapshot, "missing_sender_open_id");
    let blocks: JsonObject[] = [];
    let resourceMetadata: JsonObject[] = [];
    if (resources.length > 0) {
      const resolver = this.options.converterContext?.resolveResources ?? this.options.resolveResources;
      const resolved = resolver
        ? await resolver(resources, snapshot)
        : {
            userInput: resources.map((item) => `[${item.type}:${item.file_name || item.file_key}]`).join("\n"),
            userContentBlocks: resources.map((item) => ({ ...item })),
            resourceMetadata: resources.map((item) => ({ ...item })),
            diagnostics: [],
          };
      message = [message, resolved.userInput].map((item) => item.trim()).filter(Boolean).join("\n");
      blocks = resolved.userContentBlocks.map((item) => ({ ...item }));
      resourceMetadata = resolved.resourceMetadata.map((item) => ({ ...item }));
      diagnostics = [...diagnostics, ...resolved.diagnostics];
    }
    let quotedMessage: JsonObject | undefined;
    if (snapshot.parent_id && this.options.loadQuote) {
      const quote = await this.options.loadQuote(snapshot.parent_id, snapshot.chat_id);
      quotedMessage = { ...quote.metadata };
      diagnostics = [...diagnostics, ...(quote.diagnostics ?? [])];
      if (quote.text.trim()) message = `${quote.text.trim()}\n\n${message}`.trim();
      if (quote.userContentBlocks?.length) blocks = [...quote.userContentBlocks.map((item) => ({ ...item })), ...blocks];
      if (quote.resourceMetadata?.length) resourceMetadata = [
        ...quote.resourceMetadata.map((item) => ({ ...item, quoted: true })),
        ...resourceMetadata,
      ];
    }
    if (blocks.length > 0 && message.trim()) {
      blocks = [
        { type: "text", text: message.trim() },
        ...blocks.filter((block) => block.type !== "text"),
      ];
    }
    if (!message && blocks.length === 0 && diagnostics.length === 0) {
      return this.rejected(snapshot, "empty_content", resources.length);
    }

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
    return { accepted: true, event: {
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
      diagnostics: diagnostics.slice(0, 16),
    } };
  }

  private rejectionReason(snapshot: FeishuMessageSnapshot): FeishuInboundRejectReason | undefined {
    const messageId = snapshot.message_id;
    const now = this.monotonicMs();
    const cutoff = now - 12 * 60 * 60 * 1000;
    for (const [id, recordedAt] of this.seen) if (recordedAt < cutoff) this.seen.delete(id);
    if (messageId && this.seen.has(messageId)) return "duplicate";
    if (messageId) this.seen.set(messageId, now);
    if (!snapshot.create_time) return undefined;
    if (!/^\d+$/u.test(snapshot.create_time)) return undefined;
    const createdAt = Number(snapshot.create_time);
    if (!Number.isFinite(createdAt)) return undefined;
    return this.nowMs() - createdAt > 5 * 60 * 1000 ? "stale" : undefined;
  }

  private rejected(
    snapshot: FeishuMessageSnapshot,
    reason: FeishuInboundRejectReason,
    resourceCount = 0,
  ): FeishuNormalizeDecision {
    return {
      accepted: false,
      reason,
      metadata: {
        message_id: snapshot.message_id,
        message_type: snapshot.message_type,
        chat_id: snapshot.chat_id,
        chat_type: snapshot.chat_type,
        resource_count: resourceCount,
      },
    };
  }

  private nonEmpty(values: Record<string, string>): JsonObject {
    return Object.fromEntries(Object.entries(values).filter(([, value]) => value.trim())) as JsonObject;
  }
}
