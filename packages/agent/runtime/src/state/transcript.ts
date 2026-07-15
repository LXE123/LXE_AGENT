import type { JsonObject } from "@lxe/protocol";
import type { RuntimeMessage } from "../engine/types";

export const TRANSCRIPT_VERSION = 2;

export const replacementKinds = new Set([
  "compaction",
  "context_reset",
  "memory_clear",
  "legacy_import",
  "repair",
  "history_limit",
  "context_replacement",
]);

const text = (value: unknown): string => String(value ?? "").trim();

const object = (value: unknown): JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};

const normalizeLegacyBlock = (value: unknown): JsonObject | undefined => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const block = { ...(value as JsonObject) };
  const type = text(block.type);
  if (type === "tool_call" || type === "tool_use") {
    return {
      type: "tool_call",
      id: text(block.id),
      name: text(block.name),
      arguments: object(type === "tool_call" ? block.arguments : block.input),
    };
  }
  if (type === "tool_result") {
    const normalized: JsonObject = {
      ...block,
      type: "tool_result",
      tool_call_id: text(block.tool_call_id) || text(block.tool_use_id),
    };
    delete normalized.tool_use_id;
    return normalized;
  }
  return block;
};

export const normalizeTranscriptMessage = (value: unknown): RuntimeMessage | undefined => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as { role?: unknown; content?: unknown };
  const legacyRole = text(candidate.role);
  if (!new Set(["user", "assistant", "tool", "system"]).has(legacyRole)) return undefined;
  let role = legacyRole as RuntimeMessage["role"];
  if (!Array.isArray(candidate.content)) return { role, content: String(candidate.content ?? "") };
  const content = candidate.content.map(normalizeLegacyBlock)
    .filter((block): block is JsonObject => Boolean(block));
  // Early Bun transcripts persisted Anthropic wire messages directly. Recover
  // them only for model replay; the immutable display reader preserves disk semantics.
  if (role === "user" && content.length > 0 && content.every((block) => block.type === "tool_result")) {
    role = "tool";
  }
  return { role, content };
};

export const normalizeTranscriptMessages = (values: unknown[]): RuntimeMessage[] =>
  values.map(normalizeTranscriptMessage)
    .filter((message): message is RuntimeMessage => Boolean(message));

export const transcriptReplacementKind = (event: JsonObject): string => {
  const kind = text(event.kind);
  if (kind === "context_patch") return text(event.patch_kind);
  return kind === "replacement" ? text(event.replacement_kind) : kind;
};

export const transcriptDisplayMarker = (event: JsonObject): JsonObject | undefined => {
  const kind = transcriptReplacementKind(event);
  if (kind === "compaction") {
    const count = Math.max(0, Math.trunc(Number(event.compacted_count ?? 0)));
    return { role: "system", content: `[上下文已压缩：${count} 条消息 → 摘要]` };
  }
  if (kind === "context_reset") return { role: "system", content: "[上下文已重置]" };
  if (kind === "memory_clear") return { role: "system", content: "[上下文记忆已清空]" };
  return undefined;
};

const patchInteger = (value: unknown, name: string): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`invalid transcript context_patch ${name}`);
  return parsed;
};

export const applyTranscriptEvent = (
  previous: RuntimeMessage[],
  event: JsonObject,
): RuntimeMessage[] => {
  if (text(event.kind) === "message") {
    const message = normalizeTranscriptMessage(event.message);
    return message ? [...previous, message] : previous;
  }
  if (text(event.kind) === "context_patch") {
    const start = patchInteger(event.start, "start");
    const deleteCount = patchInteger(event.delete_count, "delete_count");
    if (start > previous.length || start + deleteCount > previous.length) {
      throw new Error("transcript context_patch is outside the current model view");
    }
    if (!Array.isArray(event.insert_messages)) {
      throw new Error("transcript context_patch insert_messages must be an array");
    }
    const inserted = normalizeTranscriptMessages(event.insert_messages);
    if (inserted.length !== event.insert_messages.length) {
      throw new Error("transcript context_patch contains an invalid message");
    }
    return [...previous.slice(0, start), ...inserted, ...previous.slice(start + deleteCount)];
  }
  const kind = transcriptReplacementKind(event);
  if (!replacementKinds.has(kind) || !Array.isArray(event.replacement_history)) return previous;
  return normalizeTranscriptMessages(event.replacement_history);
};

export const replayTranscript = (events: readonly JsonObject[]): RuntimeMessage[] => {
  let messages: RuntimeMessage[] = [];
  for (const event of events) messages = applyTranscriptEvent(messages, event);
  return messages;
};

const sameMessage = (left: RuntimeMessage, right: RuntimeMessage): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

export const createContextPatchEvent = (
  previous: readonly RuntimeMessage[],
  next: readonly RuntimeMessage[],
  patchKind: string,
  metadata: JsonObject = {},
  timestamp = Date.now() / 1_000,
): JsonObject => {
  let prefix = 0;
  const sharedLength = Math.min(previous.length, next.length);
  while (prefix < sharedLength && sameMessage(previous[prefix]!, next[prefix]!)) prefix += 1;
  let suffix = 0;
  while (
    suffix < sharedLength - prefix &&
    sameMessage(previous[previous.length - suffix - 1]!, next[next.length - suffix - 1]!)
  ) suffix += 1;
  return {
    ...metadata,
    kind: "context_patch",
    start: prefix,
    delete_count: previous.length - prefix - suffix,
    insert_messages: next.slice(prefix, next.length - suffix) as unknown as JsonObject[],
    patch_kind: patchKind,
    ts: timestamp,
  };
};

export const transcriptHeader = (sessionId: string, createdAt = new Date().toISOString()): JsonObject => ({
  kind: "transcript_header",
  version: TRANSCRIPT_VERSION,
  session_id: sessionId,
  created_at: createdAt,
});

export interface TranscriptByteLine {
  event: JsonObject;
  byteStart: number;
  byteEnd: number;
}

export interface ScannedTranscriptBuffer {
  lines: TranscriptByteLine[];
  completeBytes: number;
}

const parseEvent = (raw: string, lineNumber?: number): JsonObject => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    const location = lineNumber === undefined ? "" : ` at line ${lineNumber}`;
    throw new Error(`invalid transcript JSON${location}`, { cause });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`transcript event must be an object${lineNumber === undefined ? "" : ` at line ${lineNumber}`}`);
  }
  return parsed as JsonObject;
};

export const tryParseTranscriptEvent = (raw: string): JsonObject | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as JsonObject
    : undefined;
};

export const scanTranscriptBuffer = (
  buffer: Uint8Array,
  baseOffset = 0,
  includeFinalLine = false,
): ScannedTranscriptBuffer => {
  const decoder = new TextDecoder();
  const lines: TranscriptByteLine[] = [];
  let lineStart = 0;
  let lineNumber = 0;
  const appendLine = (lineEnd: number, byteEnd: number): void => {
    lineNumber += 1;
    const raw = decoder.decode(buffer.subarray(lineStart, lineEnd)).trim();
    if (raw) lines.push({ event: parseEvent(raw, lineNumber), byteStart: baseOffset + lineStart, byteEnd: baseOffset + byteEnd });
    lineStart = byteEnd;
  };
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] === 0x0a) appendLine(index, index + 1);
  }
  if (includeFinalLine && lineStart < buffer.length) {
    // The final line has no terminating newline, so it may be the torn tail
    // of an append interrupted by a crash. Keep terminated lines strict, but
    // exclude an unparseable unterminated tail instead of failing the scan.
    const raw = decoder.decode(buffer.subarray(lineStart)).trim();
    const event = raw ? tryParseTranscriptEvent(raw) : undefined;
    if (event) {
      lines.push({ event, byteStart: baseOffset + lineStart, byteEnd: baseOffset + buffer.length });
      lineStart = buffer.length;
    } else if (!raw) {
      lineStart = buffer.length;
    }
  }
  return { lines, completeBytes: baseOffset + lineStart };
};

export const parseTranscriptText = (raw: string): JsonObject[] => raw.split(/\r?\n/u)
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line, index) => parseEvent(line, index + 1));

const displayProjection = (events: readonly JsonObject[]): JsonObject[] => {
  const result: JsonObject[] = [];
  for (const event of events) {
    if (text(event.kind) === "message") {
      const message = object(event.message);
      if (text(message.role)) result.push(structuredClone(message));
      continue;
    }
    const marker = transcriptDisplayMarker(event);
    if (marker) result.push(marker);
  }
  return result;
};

export interface TranscriptMigrationResult {
  text: string;
  changed: boolean;
  sourceBytes: number;
  targetBytes: number;
  rawMessageCount: number;
  patchCount: number;
}

export const migrateTranscriptText = (
  raw: string,
  sessionId: string,
  createdAt = new Date().toISOString(),
): TranscriptMigrationResult => {
  const sourceEvents = parseTranscriptText(raw);
  const first = sourceEvents[0];
  if (first?.kind === "transcript_header" && Number(first.version) === TRANSCRIPT_VERSION) {
    replayTranscript(sourceEvents);
    return {
      text: raw,
      changed: false,
      sourceBytes: Buffer.byteLength(raw),
      targetBytes: Buffer.byteLength(raw),
      rawMessageCount: sourceEvents.filter((event) => event.kind === "message").length,
      patchCount: sourceEvents.filter((event) => event.kind === "context_patch").length,
    };
  }

  const targetEvents: JsonObject[] = [transcriptHeader(sessionId, createdAt)];
  let modelView: RuntimeMessage[] = [];
  let patchCount = 0;
  for (const event of sourceEvents) {
    const replacementKind = transcriptReplacementKind(event);
    if (replacementKinds.has(replacementKind) && Array.isArray(event.replacement_history)) {
      const next = normalizeTranscriptMessages(event.replacement_history);
      if (next.length !== event.replacement_history.length) {
        throw new Error(`legacy transcript replacement contains an invalid message: ${sessionId}`);
      }
      const metadata = { ...event };
      delete metadata.kind;
      delete metadata.replacement_kind;
      delete metadata.replacement_history;
      delete metadata.ts;
      targetEvents.push(createContextPatchEvent(
        modelView,
        next,
        replacementKind,
        metadata,
        Number.isFinite(Number(event.ts)) ? Number(event.ts) : 0,
      ));
      modelView = next;
      patchCount += 1;
      continue;
    }
    targetEvents.push(event);
    modelView = applyTranscriptEvent(modelView, event);
    if (event.kind === "context_patch") patchCount += 1;
  }

  const sourceModel = replayTranscript(sourceEvents);
  const targetModel = replayTranscript(targetEvents);
  if (JSON.stringify(sourceModel) !== JSON.stringify(targetModel)) {
    throw new Error(`transcript model replay changed during migration: ${sessionId}`);
  }
  if (JSON.stringify(displayProjection(sourceEvents)) !== JSON.stringify(displayProjection(targetEvents))) {
    throw new Error(`transcript display projection changed during migration: ${sessionId}`);
  }
  const sourceRawMessages = sourceEvents.filter((event) => event.kind === "message").length;
  const targetRawMessages = targetEvents.filter((event) => event.kind === "message").length;
  if (sourceRawMessages !== targetRawMessages) {
    throw new Error(`transcript raw message count changed during migration: ${sessionId}`);
  }
  const migrated = `${targetEvents.map((event) => JSON.stringify(event)).join("\n")}\n`;
  return {
    text: migrated,
    changed: true,
    sourceBytes: Buffer.byteLength(raw),
    targetBytes: Buffer.byteLength(migrated),
    rawMessageCount: sourceRawMessages,
    patchCount,
  };
};
