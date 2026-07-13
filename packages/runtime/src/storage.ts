import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";
import type { JsonObject, JsonValue } from "@lxe/protocol";
import type { RuntimeMessage, RuntimeSessionRecord, RuntimeStore, RuntimeTurnUsageRecord } from "./types";

const parseObject = (value: unknown): JsonObject => {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) return value as JsonObject;
  try {
    const parsed: unknown = JSON.parse(String(value ?? "{}"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as JsonObject
      : {};
  } catch {
    return {};
  }
};

const mergeObjects = (base: JsonObject, patch: JsonObject): JsonObject => {
  const merged: JsonObject = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const current = merged[key];
    merged[key] = value !== null && typeof value === "object" && !Array.isArray(value) &&
      current !== null && typeof current === "object" && !Array.isArray(current)
      ? mergeObjects(current as JsonObject, value as JsonObject)
      : value;
  }
  return merged;
};

const text = (value: unknown): string => String(value ?? "").trim();

const imagePlaceholder = (): JsonObject => ({
  type: "text",
  text: "[Image omitted from persisted transcript after this turn]",
});

const sanitizePersistedValue = (value: JsonValue): JsonValue => {
  if (Array.isArray(value)) return value.map(sanitizePersistedValue);
  if (value === null || typeof value !== "object") {
    return typeof value === "string" && /^data:image\/[^;]+;base64,/iu.test(value)
      ? "[Image data URL omitted from persisted transcript after this turn]"
      : value;
  }
  const source = parseObject(value.source);
  if (text(value.type) === "image" && (text(source.type) === "base64" || typeof source.data === "string")) {
    return imagePlaceholder();
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizePersistedValue(item)]));
};

const persistedMessage = (message: RuntimeMessage): RuntimeMessage =>
  sanitizePersistedValue(message as unknown as JsonObject) as unknown as RuntimeMessage;

const sessionTitle = (message: RuntimeMessage, reason: string): string => {
  if (message.role !== "user" || !["turn_input", "user_input", "inbound"].includes(reason)) return "";
  const content = typeof message.content === "string"
    ? message.content
    : message.content.filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => String(block.text)).join(" ");
  return content.replaceAll(/\s+/g, " ").trim().slice(0, 120);
};

const normalizeLegacyBlock = (value: unknown): JsonObject | undefined => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const block = { ...(value as JsonObject) };
  const type = text(block.type);
  if (type === "tool_call" || type === "tool_use") {
    return {
      type: "tool_call",
      id: text(block.id),
      name: text(block.name),
      arguments: parseObject(type === "tool_call" ? block.arguments : block.input),
    };
  }
  if (type === "tool_result") {
    const toolCallId = text(block.tool_call_id) || text(block.tool_use_id);
    const normalized: JsonObject = {
      ...block,
      type: "tool_result",
      tool_call_id: toolCallId,
    };
    delete normalized.tool_use_id;
    return normalized;
  }
  return block;
};

const normalizeLegacyMessage = (value: unknown): RuntimeMessage | undefined => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as { role?: unknown; content?: unknown };
  const legacyRole = text(candidate.role);
  if (!new Set(["user", "assistant", "tool", "system"]).has(legacyRole)) return undefined;
  let role = legacyRole as RuntimeMessage["role"];
  if (!Array.isArray(candidate.content)) return { role, content: String(candidate.content ?? "") };
  const content = candidate.content.map(normalizeLegacyBlock).filter((block): block is JsonObject => Boolean(block));
  // Early Bun transcripts persisted Anthropic wire messages directly. Recover
  // them only for model replay; the immutable display reader preserves disk semantics.
  if (role === "user" && content.length > 0 && content.every((block) => block.type === "tool_result")) {
    role = "tool";
  }
  return {
    role,
    content,
  };
};

const normalizeLegacyMessages = (values: unknown[]): RuntimeMessage[] =>
  values.map(normalizeLegacyMessage).filter((message): message is RuntimeMessage => Boolean(message));

const replacementKinds = new Set([
  "compaction",
  "context_reset",
  "memory_clear",
  "legacy_import",
  "repair",
  "history_limit",
  "context_replacement",
]);

interface TranscriptDisplayPage {
  messages: JsonObject[];
  page: JsonObject;
}

const replacementKind = (event: JsonObject): string =>
  text(event.kind) === "replacement" ? text(event.replacement_kind) : text(event.kind);

const displayReplacement = (kind: string, event: JsonObject): JsonObject | undefined => {
  if (kind === "compaction") {
    const count = Math.max(0, Math.trunc(Number(event.compacted_count ?? 0)));
    return { role: "system", content: `[上下文已压缩：${count} 条消息 → 摘要]` };
  }
  if (kind === "context_reset") return { role: "system", content: "[上下文已重置]" };
  if (kind === "memory_clear") return { role: "system", content: "[上下文记忆已清空]" };
  return undefined;
};

const transcriptDisplayPage = (
  events: JsonObject[],
  options: DashboardSessionPageOptions,
): TranscriptDisplayPage => {
  const ranges: Array<[number, number]> = [];
  let pendingStart: number | undefined;
  let pendingEnd = 0;
  const flushPending = (): void => {
    if (pendingStart === undefined) return;
    ranges.push([pendingStart, pendingEnd]);
    pendingStart = undefined;
    pendingEnd = 0;
  };
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    if (text(event.kind) === "message") {
      const message = parseObject(event.message);
      const role = text(message.role).toLowerCase();
      if (role === "assistant" || role === "tool") {
        pendingStart ??= index;
        pendingEnd = index + 1;
      } else {
        flushPending();
        ranges.push([index, index + 1]);
      }
      continue;
    }
    if (!displayReplacement(replacementKind(event), event)) continue;
    flushPending();
    ranges.push([index, index + 1]);
  }
  flushPending();

  const limit = Math.max(1, Math.min(Math.trunc(options.limit), 200));
  const total = ranges.length;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const currentPage = options.page === undefined
    ? totalPages
    : Math.max(1, Math.min(Math.trunc(options.page), totalPages));
  const start = Math.min(total, (currentPage - 1) * limit);
  const end = Math.min(total, start + limit);
  const selected = ranges.slice(start, end);
  const selectedEvents = selected.length > 0
    ? events.slice(selected[0]![0], selected.at(-1)![1])
    : [];
  const messages: JsonObject[] = [];
  for (const event of selectedEvents) {
    if (text(event.kind) === "message") {
      const message = parseObject(event.message);
      if (text(message.role)) messages.push(structuredClone(message));
      continue;
    }
    const marker = displayReplacement(replacementKind(event), event);
    if (marker) messages.push(marker);
  }
  return {
    messages,
    page: {
      total,
      raw_message_total: events.filter((event) => text(event.kind) === "message").length,
      start,
      end,
      limit,
      current_page: currentPage,
      total_pages: totalPages,
      has_previous: currentPage > 1,
      has_next: currentPage < totalPages,
    },
  };
};

export interface DashboardSessionListOptions {
  limit: number;
  offset: number;
  query?: string;
}

export interface DashboardSessionPageOptions {
  limit: number;
  page?: number;
}

export class SqliteRuntimeStore implements RuntimeStore {
  private database: Database | undefined;
  private readonly replayCache = new Map<string, { path: string; size: number; mtimeMs: number; messages: RuntimeMessage[] }>();
  private replayHits = 0;
  private replayMisses = 0;

  constructor(readonly path: string) {}

  async start(): Promise<void> {
    if (this.database) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const database = new Database(this.path, { create: true, strict: true });
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("PRAGMA busy_timeout = 5000");
    database.exec("PRAGMA journal_mode = WAL");
    database.exec(`
      CREATE TABLE IF NOT EXISTS response_routes (
        response_route_id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL,
        platform TEXT NOT NULL DEFAULT 'feishu',
        platform_message_id TEXT,
        conversation_id TEXT,
        conversation_type TEXT,
        sender_nick TEXT,
        extra_data TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_sessions (
        session_id TEXT PRIMARY KEY,
        source TEXT NOT NULL DEFAULT '{}',
        model TEXT NOT NULL DEFAULT '',
        model_config TEXT NOT NULL DEFAULT '{}',
        created_at REAL NOT NULL,
        last_active_at REAL NOT NULL,
        message_count INTEGER NOT NULL DEFAULT 0,
        tool_call_count INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        title TEXT NOT NULL DEFAULT '',
        api_call_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS agent_session_pending_events (
        queue_id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        event_id TEXT NOT NULL UNIQUE,
        job_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        text TEXT NOT NULL,
        queued_at TEXT NOT NULL,
        FOREIGN KEY(session_id) REFERENCES agent_sessions(session_id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS turn_usage (
        turn_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        started_at REAL NOT NULL,
        status TEXT NOT NULL DEFAULT '',
        elapsed_ms INTEGER NOT NULL DEFAULT 0,
        llm_calls INTEGER NOT NULL DEFAULT 0,
        tool_calls INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS turn_usage_items (
        item_id INTEGER PRIMARY KEY AUTOINCREMENT,
        turn_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        started_at REAL NOT NULL,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        module TEXT NOT NULL DEFAULT '',
        calls INTEGER NOT NULL DEFAULT 1,
        errors INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        detail TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_turn_usage_started_at ON turn_usage (started_at);
      CREATE INDEX IF NOT EXISTS idx_turn_usage_items_kind_name ON turn_usage_items (kind, name, started_at);
      CREATE INDEX IF NOT EXISTS idx_turn_usage_items_turn_id ON turn_usage_items (turn_id);
    `);
    this.database = database;
  }

  async stop(): Promise<void> {
    this.database?.close(false);
    this.database = undefined;
    this.replayCache.clear();
  }

  async ensureSession(request: JsonObject): Promise<void> {
    const sessionId = text(request.session_id);
    if (!sessionId) throw new Error("session_id required");
    const incomingSource = parseObject(request.source);
    const current = this.db().query("SELECT source FROM agent_sessions WHERE session_id = ?")
      .get(sessionId) as { source: string } | null;
    const source = mergeObjects(current ? parseObject(current.source) : {}, incomingSource);
    const now = Date.now() / 1_000;
    this.db().query(`
      INSERT INTO agent_sessions (session_id, source, created_at, last_active_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET source = excluded.source, last_active_at = excluded.last_active_at
    `).run(sessionId, JSON.stringify(source), now, now);
  }

  async rebindSession(request: JsonObject): Promise<void> {
    await this.ensureSession(request);
  }

  async getSession(sessionId: string): Promise<RuntimeSessionRecord | undefined> {
    const row = this.db().query("SELECT session_id, source FROM agent_sessions WHERE session_id = ?")
      .get(text(sessionId)) as { session_id: string; source: string } | null;
    return row ? { session_id: row.session_id, source: parseObject(row.source) } : undefined;
  }

  async upsertResponseRoute(request: JsonObject): Promise<void> {
    const responseRouteId = text(request.response_route_id);
    const source = parseObject(request.source);
    const now = new Date().toISOString();
    if (!responseRouteId) throw new Error("response_route_id required");
    const extra: JsonObject = {
      ...parseObject(request.extra_data),
      ...(text(source.message_id) ? { source_message_id: text(source.message_id) } : {}),
    };
    this.db().query(`
      INSERT INTO response_routes (
        response_route_id, owner_user_id, platform, platform_message_id,
        conversation_id, conversation_type, sender_nick, extra_data, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(response_route_id) DO UPDATE SET
        owner_user_id = excluded.owner_user_id,
        platform = excluded.platform,
        conversation_id = excluded.conversation_id,
        conversation_type = excluded.conversation_type,
        sender_nick = excluded.sender_nick,
        extra_data = excluded.extra_data,
        updated_at = excluded.updated_at
    `).run(
      responseRouteId,
      text(request.user_id) || text(source.user_id_alt) || text(source.user_id),
      text(request.platform) || text(source.platform) || "feishu",
      text(request.platform_message_id) || null,
      text(request.conversation_id) || text(source.chat_id) || null,
      text(request.conversation_type) || text(source.chat_type) || null,
      text(request.sender_nick) || text(source.user_name) || null,
      JSON.stringify(extra),
      now,
      now,
    );
  }

  async getResponseRoute(responseRouteId: string): Promise<JsonObject | undefined> {
    const row = this.db().query("SELECT * FROM response_routes WHERE response_route_id = ?")
      .get(text(responseRouteId)) as Record<string, unknown> | null;
    if (!row) return undefined;
    return {
      response_route_id: text(row.response_route_id),
      owner_user_id: text(row.owner_user_id),
      platform: text(row.platform),
      platform_message_id: row.platform_message_id === null ? null : text(row.platform_message_id),
      conversation_id: row.conversation_id === null ? null : text(row.conversation_id),
      conversation_type: row.conversation_type === null ? null : text(row.conversation_type),
      sender_nick: row.sender_nick === null ? null : text(row.sender_nick),
      extra_data: parseObject(row.extra_data),
      created_at: row.created_at === null ? null : text(row.created_at),
      updated_at: row.updated_at === null ? null : text(row.updated_at),
    };
  }

  async patchResponseRoute(responseRouteId: string, update: JsonObject): Promise<void> {
    const current = await this.getResponseRoute(responseRouteId);
    if (!current) throw new Error(`response route not found: ${responseRouteId}`);
    const extra = { ...parseObject(current.extra_data), ...parseObject(update.extra_data) };
    const rawPlatformMessageId = update.platform_message_id === undefined
      ? current.platform_message_id
      : update.platform_message_id;
    const platformMessageId = rawPlatformMessageId === null ? null : text(rawPlatformMessageId);
    this.db().query(`
      UPDATE response_routes SET platform_message_id = ?, extra_data = ?, updated_at = ?
      WHERE response_route_id = ?
    `).run(
      platformMessageId,
      JSON.stringify(extra),
      new Date().toISOString(),
      responseRouteId,
    );
  }

  async appendPendingEvent(sessionId: string, event: JsonObject): Promise<void> {
    const now = new Date().toISOString();
    const createdAt = Math.trunc(Date.now() / 1_000);
    this.db().query(`
      INSERT OR IGNORE INTO agent_session_pending_events
        (session_id, event_id, job_id, created_at, text, queued_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      text(sessionId),
      text(event.event_id) || randomUUID().replaceAll("-", ""),
      text(event.job_id),
      text(event.created_at) || String(createdAt),
      text(event.text),
      now,
    );
  }

  async hasPendingEvents(sessionId: string): Promise<boolean> {
    const row = this.db().query(
      "SELECT 1 AS present FROM agent_session_pending_events WHERE session_id = ? LIMIT 1",
    ).get(text(sessionId)) as { present: number } | null;
    return Boolean(row?.present);
  }

  async popPendingEvents(sessionId: string): Promise<JsonObject[]> {
    const safeSessionId = text(sessionId);
    const transaction = this.db().transaction(() => {
      const rows = this.db().query(`
        SELECT event_id, job_id, created_at, text, queued_at
        FROM agent_session_pending_events WHERE session_id = ? ORDER BY queue_id ASC
      `).all(safeSessionId) as Array<Record<string, unknown>>;
      this.db().query("DELETE FROM agent_session_pending_events WHERE session_id = ?").run(safeSessionId);
      return rows.map((row) => ({
        event_id: text(row.event_id),
        job_id: text(row.job_id),
        created_at: text(row.created_at),
        text: text(row.text),
        queued_at: text(row.queued_at),
      }));
    });
    return transaction();
  }

  discardPendingEvents(sessionId: string): number {
    const result = this.db().transaction(() => this.db().query(
      "DELETE FROM agent_session_pending_events WHERE session_id = ?",
    ).run(text(sessionId)))();
    return Number(result.changes ?? 0);
  }

  async resetContext(sessionId: string, reason: "context_reset" | "memory_clear" = "context_reset"): Promise<void> {
    const safeSessionId = text(sessionId);
    const path = this.transcriptPath(safeSessionId);
    this.validCacheBeforeWrite(safeSessionId, path);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify({
      kind: "replacement",
      replacement_kind: reason,
      replacement_history: [],
      ts: Date.now() / 1_000,
    })}\n`, "utf8");
    this.db().transaction(() => {
      this.db().query("UPDATE agent_sessions SET last_active_at = ?, message_count = 0 WHERE session_id = ?")
        .run(Date.now() / 1_000, safeSessionId);
      this.db().query("DELETE FROM agent_session_pending_events WHERE session_id = ?").run(safeSessionId);
    })();
    this.updateCacheAfterWrite(safeSessionId, path, []);
  }

  clearSessionRuntimeState(sessionId: string): void {
    const safeSessionId = text(sessionId);
    this.db().transaction(() => {
      const row = this.db().query("SELECT source FROM agent_sessions WHERE session_id = ?")
        .get(safeSessionId) as { source: string } | null;
      if (!row) throw new Error(`session not found: ${safeSessionId}`);
      const source = parseObject(row.source);
      delete source.tool_state;
      this.db().query("UPDATE agent_sessions SET source = ?, last_active_at = ? WHERE session_id = ?")
        .run(JSON.stringify(source), Date.now() / 1_000, safeSessionId);
      this.db().query("DELETE FROM agent_session_pending_events WHERE session_id = ?").run(safeSessionId);
    })();
  }

  replayCacheStats(): { hits: number; misses: number; entries: number } {
    return { hits: this.replayHits, misses: this.replayMisses, entries: this.replayCache.size };
  }

  async loadMessages(sessionId: string): Promise<RuntimeMessage[]> {
    const safeSessionId = text(sessionId);
    const path = this.transcriptPath(safeSessionId);
    let raw: string;
    try {
      const stat = statSync(path);
      const cached = this.replayCache.get(safeSessionId);
      if (cached && cached.path === path && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
        this.replayHits += 1;
        return structuredClone(cached.messages);
      }
      this.replayMisses += 1;
      raw = readFileSync(path, "utf8");
    } catch (error) {
      this.replayCache.delete(safeSessionId);
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return this.loadLegacyMessages(safeSessionId);
      throw error;
    }
    if (!raw.trim()) return this.loadLegacyMessages(safeSessionId);
    let messages: RuntimeMessage[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const event = parseObject(line);
      if (event.kind === "message") {
        const message = event.message as unknown;
        if (message !== null && typeof message === "object" && !Array.isArray(message)) {
          const candidate = normalizeLegacyMessage(message);
          if (candidate) messages.push(candidate);
        }
      } else {
        const kind = text(event.kind);
        const replacementKind = kind === "replacement" ? text(event.replacement_kind) : kind;
        if (!replacementKinds.has(replacementKind)) continue;
        if (Array.isArray(event.replacement_history)) {
          messages = normalizeLegacyMessages(event.replacement_history as unknown[]);
        }
      }
    }
    const stat = statSync(path);
    this.replayCache.set(safeSessionId, { path, size: stat.size, mtimeMs: stat.mtimeMs, messages: structuredClone(messages) });
    return structuredClone(messages);
  }

  async loadTranscriptDisplayPage(
    sessionId: string,
    options: DashboardSessionPageOptions,
  ): Promise<TranscriptDisplayPage> {
    const path = this.transcriptPath(text(sessionId));
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return transcriptDisplayPage([], options);
      throw error;
    }
    const events = raw.split(/\r?\n/u)
      .filter((line) => line.trim())
      .map(parseObject)
      .filter((event) => text(event.kind));
    return transcriptDisplayPage(events, options);
  }

  async appendMessage(sessionId: string, message: RuntimeMessage, reason = "runtime"): Promise<void> {
    const safeSessionId = text(sessionId);
    const path = this.transcriptPath(safeSessionId);
    const cached = this.validCacheBeforeWrite(safeSessionId, path);
    const persisted = persistedMessage(message);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify({ kind: "message", message: persisted, reason, ts: Date.now() / 1_000 })}\n`, "utf8");
    const title = sessionTitle(message, reason);
    this.db().transaction(() => {
      this.db().query(`
        UPDATE agent_sessions SET last_active_at = ?, message_count = message_count + 1,
          title = CASE WHEN title = '' AND ? <> '' THEN ? ELSE title END
        WHERE session_id = ?
      `).run(Date.now() / 1_000, title, title, safeSessionId);
    })();
    if (cached) this.updateCacheAfterWrite(safeSessionId, path, [...cached.messages, persisted]);
    else this.replayCache.delete(safeSessionId);
  }

  async replaceMessages(
    sessionId: string,
    messages: RuntimeMessage[],
    replacementKind: "compaction" | "repair" | "history_limit" | "context_replacement",
    metadata: JsonObject = {},
  ): Promise<void> {
    const safeSessionId = text(sessionId);
    const path = this.transcriptPath(safeSessionId);
    this.validCacheBeforeWrite(safeSessionId, path);
    const persisted = messages.map(persistedMessage);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify({
      ...metadata,
      kind: "replacement",
      replacement_kind: replacementKind,
      replacement_history: persisted,
      ts: Date.now() / 1_000,
    })}\n`, "utf8");
    this.db().transaction(() => {
      this.db().query("UPDATE agent_sessions SET last_active_at = ? WHERE session_id = ?")
        .run(Date.now() / 1_000, safeSessionId);
    })();
    this.updateCacheAfterWrite(safeSessionId, path, persisted);
  }

  async patchSessionState(sessionId: string, patch: JsonObject): Promise<void> {
    const safeSessionId = text(sessionId);
    const transaction = this.db().transaction(() => {
      const row = this.db().query("SELECT source FROM agent_sessions WHERE session_id = ?")
        .get(safeSessionId) as { source: string } | null;
      if (!row) throw new Error(`session not found: ${safeSessionId}`);
      const source = parseObject(row.source);
      source.tool_state = mergeObjects(parseObject(source.tool_state), patch);
      this.db().query("UPDATE agent_sessions SET source = ?, last_active_at = ? WHERE session_id = ?")
        .run(JSON.stringify(source), Date.now() / 1_000, safeSessionId);
    });
    transaction();
  }

  async recordTurn(sessionId: string, metrics: RuntimeTurnUsageRecord): Promise<void> {
    const safeSessionId = text(sessionId);
    const turnId = text(metrics.turn_id) || randomUUID().replaceAll("-", "");
    const startedAt = Number(metrics.started_at ?? Date.now() / 1_000);
    const tools = Array.isArray(metrics.tools) ? metrics.tools.map(parseObject) : [];
    const activations = Array.isArray(metrics.activations) ? metrics.activations.map(parseObject) : [];
    const executions = Array.isArray(metrics.executions) ? metrics.executions.map(parseObject) : [];
    this.db().transaction(() => {
      this.db().query(`
        UPDATE agent_sessions SET
          last_active_at = ?, input_tokens = input_tokens + ?, output_tokens = output_tokens + ?,
          tool_call_count = tool_call_count + ?, api_call_count = api_call_count + ?
        WHERE session_id = ?
      `).run(
        Date.now() / 1_000,
        Number(metrics.input_tokens ?? 0), Number(metrics.output_tokens ?? 0),
        Number(metrics.tool_calls ?? 0), Number(metrics.api_calls ?? metrics.llm_calls ?? 0), safeSessionId,
      );
      this.db().query(`
        INSERT OR REPLACE INTO turn_usage
          (turn_id, session_id, started_at, status, elapsed_ms, llm_calls, tool_calls, input_tokens, output_tokens)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        turnId, safeSessionId, startedAt, text(metrics.status), Number(metrics.elapsed_ms ?? 0),
        Number(metrics.api_calls ?? metrics.llm_calls ?? 0), Number(metrics.tool_calls ?? 0),
        Number(metrics.input_tokens ?? 0), Number(metrics.output_tokens ?? 0),
      );
      this.db().query("DELETE FROM turn_usage_items WHERE turn_id = ?").run(turnId);
      for (const tool of tools) {
        const name = text(tool.name);
        if (!name) continue;
        this.db().query(`
          INSERT INTO turn_usage_items
            (turn_id, session_id, started_at, kind, name, module, calls, errors, duration_ms, detail)
          VALUES (?, ?, ?, 'tool', ?, '', ?, ?, ?, '')
        `).run(
          turnId, safeSessionId, startedAt, name, Number(tool.calls ?? 0),
          Number(tool.errors ?? 0), Number(tool.duration_ms ?? 0),
        );
      }
      for (const activation of activations) {
        const name = text(activation.skill);
        if (!name) continue;
        this.db().query(`
          INSERT INTO turn_usage_items
            (turn_id, session_id, started_at, kind, name, module, calls, errors, duration_ms, detail)
          VALUES (?, ?, ?, 'skill_activation', ?, ?, 1, 0, 0, '')
        `).run(
          turnId, safeSessionId, startedAt, name, text(activation.module),
        );
      }
      for (const execution of executions) {
        const name = text(execution.skill);
        if (!name) continue;
        this.db().query(`
          INSERT INTO turn_usage_items
            (turn_id, session_id, started_at, kind, name, module, calls, errors, duration_ms, detail)
          VALUES (?, ?, ?, 'skill_execution', ?, ?, 1, ?, ?, ?)
        `).run(
          turnId, safeSessionId, startedAt, name, text(execution.module), execution.success === true ? 0 : 1,
          Number(execution.duration_ms ?? 0), text(execution.command),
        );
      }
    })();
  }

  usageOverview(days: number): JsonObject {
    const safeDays = Math.max(1, Math.min(Math.trunc(days), 365));
    const cutoff = Date.now() / 1_000 - safeDays * 86_400;
    const totals = this.db().query(`
      SELECT COUNT(*) AS turns, COALESCE(SUM(tool_calls), 0) AS tool_calls,
             COALESCE(SUM(llm_calls), 0) AS llm_calls, COALESCE(SUM(input_tokens), 0) AS input_tokens,
             COALESCE(SUM(output_tokens), 0) AS output_tokens,
             COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0) AS error_turns
      FROM turn_usage WHERE started_at >= ?
    `).get(cutoff) as Record<string, number>;
    const dailyTurns = this.db().query(`
      SELECT date(started_at, 'unixepoch', 'localtime') AS day, COUNT(*) AS turns,
             COALESCE(SUM(tool_calls), 0) AS tool_calls
      FROM turn_usage WHERE started_at >= ? GROUP BY day ORDER BY day ASC
    `).all(cutoff) as Array<Record<string, unknown>>;
    const dailyExecutions = this.db().query(`
      SELECT date(started_at, 'unixepoch', 'localtime') AS day,
             COALESCE(SUM(calls), 0) AS executions, COALESCE(SUM(errors), 0) AS failures
      FROM turn_usage_items WHERE kind = 'skill_execution' AND started_at >= ?
      GROUP BY day ORDER BY day ASC
    `).all(cutoff) as Array<Record<string, unknown>>;
    const skillTotals = this.db().query(`
      SELECT COALESCE(SUM(calls), 0) AS executions, COALESCE(SUM(errors), 0) AS failures
      FROM turn_usage_items WHERE kind = 'skill_execution' AND started_at >= ?
    `).get(cutoff) as Record<string, number> | null;
    const modules = this.db().query(`
      SELECT module, COUNT(DISTINCT name) AS skills, COUNT(DISTINCT turn_id) AS turns,
             COALESCE(SUM(calls), 0) AS executions, COALESCE(SUM(errors), 0) AS failures,
             COALESCE(SUM(duration_ms), 0) AS duration_ms
      FROM turn_usage_items WHERE kind = 'skill_execution' AND started_at >= ?
      GROUP BY module ORDER BY executions DESC, module ASC
    `).all(cutoff) as Array<Record<string, unknown>>;
    const executionsByDay = new Map(dailyExecutions.map((row) => [text(row.day), row]));
    return {
      days: safeDays,
      totals: {
        turns: Number(totals.turns ?? 0), error_turns: Number(totals.error_turns ?? 0),
        tool_calls: Number(totals.tool_calls ?? 0), llm_calls: Number(totals.llm_calls ?? 0),
        input_tokens: Number(totals.input_tokens ?? 0), output_tokens: Number(totals.output_tokens ?? 0),
        skill_executions: Number(skillTotals?.executions ?? 0), skill_failures: Number(skillTotals?.failures ?? 0),
      },
      modules: modules.map((row) => ({
        module: text(row.module), skills: Number(row.skills ?? 0), turns: Number(row.turns ?? 0),
        executions: Number(row.executions ?? 0), failures: Number(row.failures ?? 0),
        duration_ms: Number(row.duration_ms ?? 0),
      })),
      daily: dailyTurns.map((row) => {
        const execution = executionsByDay.get(text(row.day));
        return {
          day: text(row.day), turns: Number(row.turns ?? 0), tool_calls: Number(row.tool_calls ?? 0),
          executions: Number(execution?.executions ?? 0), failures: Number(execution?.failures ?? 0),
        };
      }),
    };
  }

  toolUsageStats(days: number): JsonObject[] {
    const cutoff = Date.now() / 1_000 - Math.max(1, Math.min(Math.trunc(days), 365)) * 86_400;
    const rows = this.db().query(`
      SELECT name, COALESCE(SUM(calls), 0) AS calls, COALESCE(SUM(errors), 0) AS errors,
             COALESCE(SUM(duration_ms), 0) AS duration_ms, COUNT(DISTINCT turn_id) AS turns,
             MAX(started_at) AS last_used_at
      FROM turn_usage_items WHERE kind = 'tool' AND started_at >= ?
      GROUP BY name ORDER BY calls DESC, name ASC
    `).all(cutoff) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      name: text(row.name), calls: Number(row.calls ?? 0), errors: Number(row.errors ?? 0),
      duration_ms: Number(row.duration_ms ?? 0), turns: Number(row.turns ?? 0), last_used_at: Number(row.last_used_at ?? 0),
    }));
  }

  skillUsageStats(days: number, name = ""): JsonObject[] {
    const cutoff = Date.now() / 1_000 - Math.max(1, Math.min(Math.trunc(days), 365)) * 86_400;
    const skillName = text(name);
    const rows = this.db().query(`
      SELECT name, MAX(module) AS module,
             COALESCE(SUM(CASE WHEN kind = 'skill_activation' THEN calls ELSE 0 END), 0) AS activations,
             COALESCE(SUM(CASE WHEN kind = 'skill_execution' THEN calls ELSE 0 END), 0) AS executions,
             COALESCE(SUM(CASE WHEN kind = 'skill_execution' THEN errors ELSE 0 END), 0) AS failures,
             COUNT(DISTINCT CASE WHEN kind = 'skill_execution' THEN turn_id END) AS execution_turns,
             COALESCE(SUM(CASE WHEN kind = 'skill_execution' THEN duration_ms ELSE 0 END), 0) AS duration_ms,
             MAX(started_at) AS last_used_at
      FROM turn_usage_items
      WHERE kind IN ('skill_activation', 'skill_execution') AND started_at >= ? AND (? = '' OR name = ?)
      GROUP BY name ORDER BY executions DESC, activations DESC, name ASC
    `).all(cutoff, skillName, skillName) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      name: text(row.name), module: text(row.module), activations: Number(row.activations ?? 0),
      executions: Number(row.executions ?? 0),
      failures: Number(row.failures ?? 0), duration_ms: Number(row.duration_ms ?? 0),
      execution_turns: Number(row.execution_turns ?? 0), last_used_at: Number(row.last_used_at ?? 0),
    }));
  }

  skillUsageDetail(name: string, days: number, failureLimit = 10): JsonObject {
    const skillName = text(name);
    const cutoff = Date.now() / 1_000 - Math.max(1, Math.min(Math.trunc(days), 365)) * 86_400;
    const safeFailureLimit = Math.max(1, Math.min(Math.trunc(failureLimit), 50));
    const daily = this.db().query(`
      SELECT date(started_at, 'unixepoch', 'localtime') AS day,
             COALESCE(SUM(CASE WHEN kind = 'skill_activation' THEN calls ELSE 0 END), 0) AS activations,
             COALESCE(SUM(CASE WHEN kind = 'skill_execution' THEN calls ELSE 0 END), 0) AS executions,
             COALESCE(SUM(CASE WHEN kind = 'skill_execution' THEN errors ELSE 0 END), 0) AS failures
      FROM turn_usage_items
      WHERE name = ? AND kind IN ('skill_activation', 'skill_execution') AND started_at >= ?
      GROUP BY day ORDER BY day ASC
    `).all(skillName, cutoff) as Array<Record<string, unknown>>;
    const failures = this.db().query(`
      SELECT turn_id, session_id, started_at, detail
      FROM turn_usage_items
      WHERE name = ? AND kind = 'skill_execution' AND errors > 0 AND started_at >= ?
      ORDER BY started_at DESC LIMIT ?
    `).all(skillName, cutoff, safeFailureLimit) as Array<Record<string, unknown>>;
    return {
      name: skillName,
      daily: daily.map((row) => ({
        day: text(row.day), activations: Number(row.activations ?? 0),
        executions: Number(row.executions ?? 0), failures: Number(row.failures ?? 0),
      })),
      recent_failures: failures.map((row) => ({
        turn_id: text(row.turn_id), session_id: text(row.session_id), started_at: Number(row.started_at ?? 0),
        command: text(row.detail),
      })),
    };
  }

  exportTurnUsage(days: number, limit = 5_000): JsonObject[] {
    const cutoff = Date.now() / 1_000 - Math.max(1, Math.min(Math.trunc(days), 365)) * 86_400;
    const rows = this.db().query(`
      SELECT turn_id, session_id, started_at, status, elapsed_ms, llm_calls, tool_calls, input_tokens, output_tokens
      FROM turn_usage WHERE started_at >= ? ORDER BY started_at ASC LIMIT ?
    `).all(cutoff, Math.max(1, Math.min(Math.trunc(limit), 50_000))) as Array<Record<string, unknown>>;
    const turns = rows.map((row) => ({
      turn_id: text(row.turn_id), session_id: text(row.session_id), started_at: Number(row.started_at ?? 0),
      status: text(row.status), elapsed_ms: Number(row.elapsed_ms ?? 0), llm_calls: Number(row.llm_calls ?? 0),
      tool_calls: Number(row.tool_calls ?? 0), input_tokens: Number(row.input_tokens ?? 0), output_tokens: Number(row.output_tokens ?? 0),
      items: [] as JsonObject[],
    }));
    const byId = new Map(turns.map((turn) => [turn.turn_id, turn]));
    if (turns.length > 0) {
      const items = this.db().query(`
        SELECT turn_id, kind, name, module, calls, errors, duration_ms, detail
        FROM turn_usage_items
        WHERE started_at >= ? AND kind IN ('tool', 'skill_activation', 'skill_execution')
        ORDER BY item_id ASC
      `).all(cutoff) as Array<Record<string, unknown>>;
      for (const row of items) {
        byId.get(text(row.turn_id))?.items.push({
          kind: text(row.kind), name: text(row.name), module: text(row.module), calls: Number(row.calls ?? 0),
          errors: Number(row.errors ?? 0), duration_ms: Number(row.duration_ms ?? 0), detail: text(row.detail),
        });
      }
    }
    return turns;
  }

  listSessions(options: DashboardSessionListOptions): {
    items: JsonObject[];
    limit: number;
    offset: number;
    total: number;
    summary: JsonObject;
  } {
    const limit = Math.max(1, Math.min(Math.trunc(options.limit), 200));
    const offset = Math.max(0, Math.trunc(options.offset));
    const needle = text(options.query).toLowerCase();
    const where = needle
      ? "WHERE lower(coalesce(session_id, '')) LIKE ? OR lower(coalesce(title, '')) LIKE ? OR lower(coalesce(model, '')) LIKE ? OR lower(coalesce(source, '')) LIKE ?"
      : "";
    const whereArgs = needle ? Array(4).fill(`%${needle}%`) : [];
    const totalRow = this.db().query(`SELECT COUNT(*) AS count FROM agent_sessions ${where}`)
      .get(...whereArgs) as { count: number } | null;
    const rows = this.db().query(`
      SELECT session_id, source, model, model_config, created_at, last_active_at,
             message_count, tool_call_count, input_tokens, output_tokens, title, api_call_count
      FROM agent_sessions ${where}
      ORDER BY last_active_at DESC, created_at DESC, session_id ASC LIMIT ? OFFSET ?
    `).all(...whereArgs, limit, offset) as Array<Record<string, unknown>>;
    const summary = this.db().query(`
      SELECT COUNT(*) AS total_sessions, COALESCE(SUM(tool_call_count), 0) AS tool_call_count,
             COALESCE(SUM(input_tokens + output_tokens), 0) AS token_count FROM agent_sessions
    `).get() as Record<string, number> | null;
    return {
      items: rows.map((row) => this.sessionPayload(row)),
      limit,
      offset,
      total: Number(totalRow?.count ?? 0),
      summary: {
        total_sessions: Number(summary?.total_sessions ?? 0),
        tool_call_count: Number(summary?.tool_call_count ?? 0),
        token_count: Number(summary?.token_count ?? 0),
      },
    };
  }

  async sessionDetail(sessionId: string, options: DashboardSessionPageOptions): Promise<JsonObject | undefined> {
    const row = this.db().query(`
      SELECT session_id, source, model, model_config, created_at, last_active_at,
             message_count, tool_call_count, input_tokens, output_tokens, title, api_call_count
      FROM agent_sessions WHERE session_id = ?
    `).get(text(sessionId)) as Record<string, unknown> | null;
    if (!row) return undefined;
    const display = await this.loadTranscriptDisplayPage(text(sessionId), options);
    return {
      session: this.sessionPayload(row),
      messages: display.messages,
      messages_page: display.page,
    };
  }

  private db(): Database {
    if (!this.database) throw new Error("runtime store is not started");
    return this.database;
  }

  private sessionPayload(row: Record<string, unknown>): JsonObject {
    const source = parseObject(row.source);
    return {
      session_id: text(row.session_id),
      title: text(row.title),
      source,
      source_summary: {
        platform: text(source.platform) || "unknown",
        chat_type: text(source.chat_type),
      },
      model: text(row.model),
      model_config: parseObject(row.model_config),
      created_at: Number(row.created_at ?? 0),
      last_active_at: Number(row.last_active_at ?? 0),
      message_count: Number(row.message_count ?? 0),
      tool_call_count: Number(row.tool_call_count ?? 0),
      input_tokens: Number(row.input_tokens ?? 0),
      output_tokens: Number(row.output_tokens ?? 0),
      api_call_count: Number(row.api_call_count ?? 0),
    };
  }

  private validCacheBeforeWrite(
    sessionId: string,
    path: string,
  ): { path: string; size: number; mtimeMs: number; messages: RuntimeMessage[] } | undefined {
    const cached = this.replayCache.get(sessionId);
    if (!cached || cached.path !== path) return undefined;
    try {
      const stat = statSync(path);
      if (cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached;
    } catch {
      // External deletion invalidates the replay cache.
    }
    this.replayCache.delete(sessionId);
    return undefined;
  }

  private updateCacheAfterWrite(sessionId: string, path: string, messages: RuntimeMessage[]): void {
    const stat = statSync(path);
    this.replayCache.set(sessionId, {
      path,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      messages: structuredClone(messages),
    });
  }

  private transcriptPath(sessionId: string): string {
    const safe = text(sessionId).replaceAll(/[^A-Za-z0-9_.-]/g, "_");
    return join(dirname(this.path), "session_transcripts", `${safe}.jsonl`);
  }

  private loadLegacyMessages(sessionId: string): RuntimeMessage[] {
    const safe = text(sessionId).replaceAll(/[^A-Za-z0-9_.-]/g, "_");
    const path = join(dirname(this.path), "session_messages", `${safe}.jsonl`);
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return normalizeLegacyMessages(raw.split(/\r?\n/).filter((line) => line.trim()).map(parseObject));
  }
}
