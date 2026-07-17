import { mkdirSync, readFileSync, statSync } from "node:fs";
import { appendFile, mkdir, open, readFile, stat, truncate } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";
import type { SQLQueryBindings } from "bun:sqlite";
import type { JsonObject, JsonValue, SessionWorkspaceRequest, WorkspaceContext } from "@lxe/protocol";
import type {
  RuntimeMessage,
  RuntimeSessionRecord,
  RuntimeStore,
  RuntimeTurnContextRecord,
  RuntimeTurnUsageRecord,
} from "../engine/types";
import {
  createLogger,
  sameWorkspaceContext,
  SessionWorkspaceMismatchError,
  workspaceContextFrom,
} from "@lxe/core";
import {
  applyTranscriptEvent,
  createContextPatchEvent,
  normalizeTranscriptMessages,
  scanTranscriptBuffer,
  transcriptDisplayMarker,
  transcriptHeader,
  tryParseTranscriptEvent,
} from "./transcript";

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

interface TranscriptDisplayPage {
  messages: JsonObject[];
  page: JsonObject;
}

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
    if (!transcriptDisplayMarker(event)) continue;
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
    const marker = transcriptDisplayMarker(event);
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

interface ReplayCacheEntry {
  path: string;
  size: number;
  mtimeMs: number;
  byteSize: number;
  messages: RuntimeMessage[];
}

interface TranscriptFileState {
  file_size: number;
  mtime_ms: number;
  indexed_bytes: number;
  event_count: number;
  raw_message_count: number;
  display_group_count: number;
  last_display_kind: string;
}

export interface SqliteRuntimeStoreOptions {
  replayCacheMaxEntries?: number;
  replayCacheMaxBytes?: number;
  legacyWorkspace?: WorkspaceContext;
}

const DEFAULT_REPLAY_CACHE_MAX_ENTRIES = 32;
const DEFAULT_REPLAY_CACHE_MAX_BYTES = 64 * 1024 * 1024;

export class SqliteRuntimeStore implements RuntimeStore {
  private readonly logger = createLogger("runtime.storage");
  private database: Database | undefined;
  private readonly replayCache = new Map<string, ReplayCacheEntry>();
  private readonly writeQueues = new Map<string, Promise<void>>();
  private readonly indexQueues = new Map<string, Promise<void>>();
  private readonly replayCacheMaxEntries: number;
  private readonly replayCacheMaxBytes: number;
  private replayCacheBytes = 0;
  private replayHits = 0;
  private replayMisses = 0;

  constructor(readonly path: string, private readonly options: SqliteRuntimeStoreOptions = {}) {
    this.replayCacheMaxEntries = Math.max(0, Math.trunc(
      options.replayCacheMaxEntries ?? DEFAULT_REPLAY_CACHE_MAX_ENTRIES,
    ));
    this.replayCacheMaxBytes = Math.max(0, Math.trunc(
      options.replayCacheMaxBytes ?? DEFAULT_REPLAY_CACHE_MAX_BYTES,
    ));
  }

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
        workspace_server_scope TEXT NOT NULL DEFAULT '',
        workspace_directory TEXT NOT NULL DEFAULT '',
        workspace_worktree TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        reasoning_effort TEXT NOT NULL DEFAULT '',
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
      CREATE TABLE IF NOT EXISTS transcript_file_state (
        session_id TEXT PRIMARY KEY,
        file_size INTEGER NOT NULL DEFAULT 0,
        mtime_ms REAL NOT NULL DEFAULT 0,
        indexed_bytes INTEGER NOT NULL DEFAULT 0,
        event_count INTEGER NOT NULL DEFAULT 0,
        raw_message_count INTEGER NOT NULL DEFAULT 0,
        display_group_count INTEGER NOT NULL DEFAULT 0,
        last_display_kind TEXT NOT NULL DEFAULT '',
        updated_at REAL NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS transcript_display_groups (
        session_id TEXT NOT NULL,
        group_number INTEGER NOT NULL,
        byte_start INTEGER NOT NULL,
        byte_end INTEGER NOT NULL,
        group_kind TEXT NOT NULL,
        PRIMARY KEY (session_id, group_number)
      );
      CREATE INDEX IF NOT EXISTS idx_turn_usage_started_at ON turn_usage (started_at);
      CREATE INDEX IF NOT EXISTS idx_turn_usage_items_kind_name ON turn_usage_items (kind, name, started_at);
      CREATE INDEX IF NOT EXISTS idx_turn_usage_items_turn_id ON turn_usage_items (turn_id);
      CREATE INDEX IF NOT EXISTS idx_transcript_display_groups_session
        ON transcript_display_groups (session_id, group_number);
    `);
    this.database = database;
    const columns = this.allPrepared<{ name: string }>("PRAGMA table_info(agent_sessions)");
    if (!columns.some((column) => column.name === "reasoning_effort")) {
      database.exec("ALTER TABLE agent_sessions ADD COLUMN reasoning_effort TEXT NOT NULL DEFAULT ''");
    }
    for (const [name, declaration] of [
      ["workspace_server_scope", "TEXT NOT NULL DEFAULT ''"],
      ["workspace_directory", "TEXT NOT NULL DEFAULT ''"],
      ["workspace_worktree", "TEXT NOT NULL DEFAULT ''"],
    ] as const) {
      if (!columns.some((column) => column.name === name)) {
        database.exec(`ALTER TABLE agent_sessions ADD COLUMN ${name} ${declaration}`);
      }
    }
    if (this.options.legacyWorkspace) {
      const workspace = this.options.legacyWorkspace;
      database.query(`
        UPDATE agent_sessions SET
          workspace_server_scope = ?, workspace_directory = ?, workspace_worktree = ?
        WHERE workspace_server_scope = '' OR workspace_directory = '' OR workspace_worktree = ''
      `).run(workspace.server_scope, workspace.directory, workspace.worktree);
    }
    await this.catchUpTranscriptIndexes();
  }

  async stop(): Promise<void> {
    await Promise.all([...this.writeQueues.values(), ...this.indexQueues.values()]);
    this.database?.close(false);
    this.database = undefined;
    this.clearReplayCache();
  }

  async ensureSession(request: SessionWorkspaceRequest): Promise<void> {
    const sessionId = text(request.session_id);
    if (!sessionId) throw new Error("session_id required");
    const workspace = workspaceContextFrom(request.workspace);
    const incomingSource = parseObject(request.source);
    const current = this.getPrepared<{
      source: string;
      workspace_server_scope: string;
      workspace_directory: string;
      workspace_worktree: string;
    }>(
      `SELECT source, workspace_server_scope, workspace_directory, workspace_worktree
       FROM agent_sessions WHERE session_id = ?`,
      sessionId,
    );
    const currentWorkspace = current ? this.workspaceFromRow(current) : undefined;
    if (currentWorkspace && !sameWorkspaceContext(currentWorkspace, workspace)) {
      throw new SessionWorkspaceMismatchError(sessionId);
    }
    const source = mergeObjects(current ? parseObject(current.source) : {}, incomingSource);
    const now = Date.now() / 1_000;
    this.db().query(`
      INSERT INTO agent_sessions (
        session_id, source, workspace_server_scope, workspace_directory, workspace_worktree,
        created_at, last_active_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        source = excluded.source,
        workspace_server_scope = excluded.workspace_server_scope,
        workspace_directory = excluded.workspace_directory,
        workspace_worktree = excluded.workspace_worktree,
        last_active_at = excluded.last_active_at
    `).run(
      sessionId,
      JSON.stringify(source),
      workspace.server_scope,
      workspace.directory,
      workspace.worktree,
      now,
      now,
    );
  }

  async rebindSession(request: SessionWorkspaceRequest): Promise<void> {
    await this.ensureSession(request);
  }

  async getSession(sessionId: string): Promise<RuntimeSessionRecord | undefined> {
    const row = this.getPrepared<{
      session_id: string;
      source: string;
      workspace_server_scope: string;
      workspace_directory: string;
      workspace_worktree: string;
    }>(
      `SELECT session_id, source, workspace_server_scope, workspace_directory, workspace_worktree
       FROM agent_sessions WHERE session_id = ?`,
      text(sessionId),
    );
    if (!row) return undefined;
    const workspace = this.workspaceFromRow(row);
    if (!workspace) throw new Error(`session workspace is missing: ${row.session_id}`);
    return { session_id: row.session_id, source: parseObject(row.source), workspace };
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
    const row = this.getPrepared<Record<string, unknown>>(
      "SELECT * FROM response_routes WHERE response_route_id = ?",
      text(responseRouteId),
    );
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
    const row = this.getPrepared<{ present: number }>(
      "SELECT 1 AS present FROM agent_session_pending_events WHERE session_id = ? LIMIT 1",
      text(sessionId),
    );
    return Boolean(row?.present);
  }

  async popPendingEvents(sessionId: string): Promise<JsonObject[]> {
    const safeSessionId = text(sessionId);
    const transaction = this.db().transaction(() => {
      const rows = this.allPrepared<Record<string, unknown>>(`
        SELECT event_id, job_id, created_at, text, queued_at
        FROM agent_session_pending_events WHERE session_id = ? ORDER BY queue_id ASC
      `, safeSessionId);
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

  discardPendingEvent(sessionId: string, jobId: string): number {
    const safeSessionId = text(sessionId);
    const safeJobId = text(jobId);
    if (!safeSessionId || !safeJobId) return 0;
    const result = this.db().transaction(() => this.db().query(`
      DELETE FROM agent_session_pending_events
      WHERE session_id = ? AND job_id = ?
    `).run(safeSessionId, safeJobId))();
    return Number(result.changes ?? 0);
  }

  discardPendingEvents(sessionId: string): number {
    const result = this.db().transaction(() => this.db().query(
      "DELETE FROM agent_session_pending_events WHERE session_id = ?",
    ).run(text(sessionId)))();
    return Number(result.changes ?? 0);
  }

  async resetContext(sessionId: string, reason: "context_reset" | "memory_clear" = "context_reset"): Promise<void> {
    const safeSessionId = text(sessionId);
    await this.enqueueSessionWrite(safeSessionId, async () => {
      const path = this.transcriptPath(safeSessionId);
      const previous = await this.loadMessagesUnqueued(safeSessionId);
      this.validCacheBeforeWrite(safeSessionId, path);
      await this.appendTranscriptEvent(safeSessionId, createContextPatchEvent(previous, [], reason));
      this.db().transaction(() => {
        this.db().query("UPDATE agent_sessions SET last_active_at = ?, message_count = 0 WHERE session_id = ?")
          .run(Date.now() / 1_000, safeSessionId);
        this.db().query("DELETE FROM agent_session_pending_events WHERE session_id = ?").run(safeSessionId);
      })();
      await this.updateCacheAfterWrite(safeSessionId, path, []);
      await this.enqueueIndexSync(safeSessionId, path);
    });
  }

  clearSessionRuntimeState(sessionId: string): void {
    const safeSessionId = text(sessionId);
    this.db().transaction(() => {
      const row = this.getPrepared<{ source: string }>(
        "SELECT source FROM agent_sessions WHERE session_id = ?",
        safeSessionId,
      );
      if (!row) throw new Error(`session not found: ${safeSessionId}`);
      const source = parseObject(row.source);
      delete source.tool_state;
      this.db().query("UPDATE agent_sessions SET source = ?, last_active_at = ? WHERE session_id = ?")
        .run(JSON.stringify(source), Date.now() / 1_000, safeSessionId);
      this.db().query("DELETE FROM agent_session_pending_events WHERE session_id = ?").run(safeSessionId);
    })();
  }

  replayCacheStats(): { hits: number; misses: number; entries: number; bytes: number } {
    return {
      hits: this.replayHits,
      misses: this.replayMisses,
      entries: this.replayCache.size,
      bytes: this.replayCacheBytes,
    };
  }

  async loadMessages(sessionId: string): Promise<RuntimeMessage[]> {
    const safeSessionId = text(sessionId);
    await this.waitForSessionWrites(safeSessionId);
    return await this.loadMessagesUnqueued(safeSessionId);
  }

  private async loadMessagesUnqueued(safeSessionId: string): Promise<RuntimeMessage[]> {
    const path = this.transcriptPath(safeSessionId);
    let raw: Uint8Array;
    try {
      const fileStat = await stat(path);
      const cached = this.replayCache.get(safeSessionId);
      if (cached && cached.path === path && cached.size === fileStat.size && cached.mtimeMs === fileStat.mtimeMs) {
        this.replayHits += 1;
        this.touchReplayCache(safeSessionId, cached);
        return structuredClone(cached.messages);
      }
      this.replayMisses += 1;
      raw = await readFile(path);
    } catch (error) {
      this.removeReplayCacheEntry(safeSessionId);
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return this.loadLegacyMessages(safeSessionId);
      throw error;
    }
    if (raw.length === 0) return this.loadLegacyMessages(safeSessionId);
    let messages: RuntimeMessage[] = [];
    const scanned = scanTranscriptBuffer(raw, 0, true);
    for (const { event } of scanned.lines) messages = applyTranscriptEvent(messages, event);
    const fileStat = await stat(path);
    this.installReplayCacheEntry(safeSessionId, path, fileStat.size, fileStat.mtimeMs, messages);
    return structuredClone(messages);
  }

  async loadTranscriptDisplayPage(
    sessionId: string,
    options: DashboardSessionPageOptions,
  ): Promise<TranscriptDisplayPage> {
    const safeSessionId = text(sessionId);
    const path = this.transcriptPath(safeSessionId);
    await this.waitForSessionWrites(safeSessionId);
    const state = await this.enqueueIndexSync(safeSessionId, path);
    if (!state) return transcriptDisplayPage([], options);
    return await this.readIndexedDisplayPage(safeSessionId, path, state, options);
  }

  async appendMessage(sessionId: string, message: RuntimeMessage, reason = "runtime"): Promise<void> {
    const safeSessionId = text(sessionId);
    await this.enqueueSessionWrite(safeSessionId, async () => {
      const path = this.transcriptPath(safeSessionId);
      const cached = this.validCacheBeforeWrite(safeSessionId, path);
      const persisted = persistedMessage(message);
      await this.appendTranscriptEvent(safeSessionId, {
        kind: "message",
        message: persisted as unknown as JsonObject,
        reason,
        ts: Date.now() / 1_000,
      });
      const title = sessionTitle(message, reason);
      this.db().query(`
          UPDATE agent_sessions SET last_active_at = ?, message_count = message_count + 1,
            title = CASE WHEN title = '' AND ? <> '' THEN ? ELSE title END
          WHERE session_id = ?
        `).run(Date.now() / 1_000, title, title, safeSessionId);
      if (cached) await this.appendReplayCacheMessage(safeSessionId, path, cached, persisted);
      else this.removeReplayCacheEntry(safeSessionId);
      await this.enqueueIndexSync(safeSessionId, path);
    });
  }

  async appendTurnContext(sessionId: string, context: RuntimeTurnContextRecord): Promise<void> {
    const safeSessionId = text(sessionId);
    await this.enqueueSessionWrite(safeSessionId, async () => {
      const path = this.transcriptPath(safeSessionId);
      const cached = this.validCacheBeforeWrite(safeSessionId, path);
      await this.appendTranscriptEvent(safeSessionId, {
        kind: "turn_context",
        turn_id: text(context.turn_id),
        job_kind: context.job_kind,
        provider: text(context.provider),
        model: text(context.model),
        effort: text(context.effort),
        thinking_enabled: context.thinking_enabled === true,
        provider_generation: Math.max(0, Math.trunc(Number(context.provider_generation ?? 0))),
        context_window_tokens: Math.max(0, Math.trunc(Number(context.context_window_tokens ?? 0))),
        ts: Number(context.ts ?? Date.now() / 1_000),
      });
      if (cached) await this.refreshReplayCacheMetadata(safeSessionId, path, cached);
      await this.enqueueIndexSync(safeSessionId, path);
    });
  }

  async replaceMessages(
    sessionId: string,
    messages: RuntimeMessage[],
    replacementKind: "compaction" | "repair" | "history_limit" | "context_replacement",
    metadata: JsonObject = {},
  ): Promise<void> {
    const safeSessionId = text(sessionId);
    await this.enqueueSessionWrite(safeSessionId, async () => {
      const path = this.transcriptPath(safeSessionId);
      const previous = await this.loadMessagesUnqueued(safeSessionId);
      this.validCacheBeforeWrite(safeSessionId, path);
      const persisted = messages.map(persistedMessage);
      await this.appendTranscriptEvent(
        safeSessionId,
        createContextPatchEvent(previous, persisted, replacementKind, metadata),
      );
      this.db().query("UPDATE agent_sessions SET last_active_at = ? WHERE session_id = ?")
        .run(Date.now() / 1_000, safeSessionId);
      await this.updateCacheAfterWrite(safeSessionId, path, persisted);
      await this.enqueueIndexSync(safeSessionId, path);
    });
  }

  async patchSessionState(sessionId: string, patch: JsonObject): Promise<void> {
    const safeSessionId = text(sessionId);
    const transaction = this.db().transaction(() => {
      const row = this.getPrepared<{ source: string }>(
        "SELECT source FROM agent_sessions WHERE session_id = ?",
        safeSessionId,
      );
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
    const totals = this.getPrepared<Record<string, number>>(`
      SELECT COUNT(*) AS turns, COALESCE(SUM(tool_calls), 0) AS tool_calls,
             COALESCE(SUM(llm_calls), 0) AS llm_calls, COALESCE(SUM(input_tokens), 0) AS input_tokens,
             COALESCE(SUM(output_tokens), 0) AS output_tokens,
             COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0) AS error_turns
      FROM turn_usage WHERE started_at >= ?
    `, cutoff) ?? {};
    const dailyTurns = this.allPrepared<Record<string, unknown>>(`
      SELECT date(started_at, 'unixepoch', 'localtime') AS day, COUNT(*) AS turns,
             COALESCE(SUM(tool_calls), 0) AS tool_calls
      FROM turn_usage WHERE started_at >= ? GROUP BY day ORDER BY day ASC
    `, cutoff);
    const dailyExecutions = this.allPrepared<Record<string, unknown>>(`
      SELECT date(started_at, 'unixepoch', 'localtime') AS day,
             COALESCE(SUM(calls), 0) AS executions, COALESCE(SUM(errors), 0) AS failures
      FROM turn_usage_items WHERE kind = 'skill_execution' AND started_at >= ?
      GROUP BY day ORDER BY day ASC
    `, cutoff);
    const skillTotals = this.getPrepared<Record<string, number>>(`
      SELECT COALESCE(SUM(calls), 0) AS executions, COALESCE(SUM(errors), 0) AS failures
      FROM turn_usage_items WHERE kind = 'skill_execution' AND started_at >= ?
    `, cutoff);
    const modules = this.allPrepared<Record<string, unknown>>(`
      SELECT module, COUNT(DISTINCT name) AS skills, COUNT(DISTINCT turn_id) AS turns,
             COALESCE(SUM(calls), 0) AS executions, COALESCE(SUM(errors), 0) AS failures,
             COALESCE(SUM(duration_ms), 0) AS duration_ms
      FROM turn_usage_items WHERE kind = 'skill_execution' AND started_at >= ?
      GROUP BY module ORDER BY executions DESC, module ASC
    `, cutoff);
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
    const rows = this.allPrepared<Record<string, unknown>>(`
      SELECT name, COALESCE(SUM(calls), 0) AS calls, COALESCE(SUM(errors), 0) AS errors,
             COALESCE(SUM(duration_ms), 0) AS duration_ms, COUNT(DISTINCT turn_id) AS turns,
             MAX(started_at) AS last_used_at
      FROM turn_usage_items WHERE kind = 'tool' AND started_at >= ?
      GROUP BY name ORDER BY calls DESC, name ASC
    `, cutoff);
    return rows.map((row) => ({
      name: text(row.name), calls: Number(row.calls ?? 0), errors: Number(row.errors ?? 0),
      duration_ms: Number(row.duration_ms ?? 0), turns: Number(row.turns ?? 0), last_used_at: Number(row.last_used_at ?? 0),
    }));
  }

  skillUsageStats(days: number, name = ""): JsonObject[] {
    const cutoff = Date.now() / 1_000 - Math.max(1, Math.min(Math.trunc(days), 365)) * 86_400;
    const skillName = text(name);
    const rows = this.allPrepared<Record<string, unknown>>(`
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
    `, cutoff, skillName, skillName);
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
    const daily = this.allPrepared<Record<string, unknown>>(`
      SELECT date(started_at, 'unixepoch', 'localtime') AS day,
             COALESCE(SUM(CASE WHEN kind = 'skill_activation' THEN calls ELSE 0 END), 0) AS activations,
             COALESCE(SUM(CASE WHEN kind = 'skill_execution' THEN calls ELSE 0 END), 0) AS executions,
             COALESCE(SUM(CASE WHEN kind = 'skill_execution' THEN errors ELSE 0 END), 0) AS failures
      FROM turn_usage_items
      WHERE name = ? AND kind IN ('skill_activation', 'skill_execution') AND started_at >= ?
      GROUP BY day ORDER BY day ASC
    `, skillName, cutoff);
    const failures = this.allPrepared<Record<string, unknown>>(`
      SELECT turn_id, session_id, started_at, detail
      FROM turn_usage_items
      WHERE name = ? AND kind = 'skill_execution' AND errors > 0 AND started_at >= ?
      ORDER BY started_at DESC LIMIT ?
    `, skillName, cutoff, safeFailureLimit);
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
    const rows = this.allPrepared<Record<string, unknown>>(`
      SELECT turn_id, session_id, started_at, status, elapsed_ms, llm_calls, tool_calls, input_tokens, output_tokens
      FROM turn_usage WHERE started_at >= ? ORDER BY started_at ASC LIMIT ?
    `, cutoff, Math.max(1, Math.min(Math.trunc(limit), 50_000)));
    const turns = rows.map((row) => ({
      turn_id: text(row.turn_id), session_id: text(row.session_id), started_at: Number(row.started_at ?? 0),
      status: text(row.status), elapsed_ms: Number(row.elapsed_ms ?? 0), llm_calls: Number(row.llm_calls ?? 0),
      tool_calls: Number(row.tool_calls ?? 0), input_tokens: Number(row.input_tokens ?? 0), output_tokens: Number(row.output_tokens ?? 0),
      items: [] as JsonObject[],
    }));
    const byId = new Map(turns.map((turn) => [turn.turn_id, turn]));
    if (turns.length > 0) {
      const items = this.allPrepared<Record<string, unknown>>(`
        SELECT turn_id, kind, name, module, calls, errors, duration_ms, detail
        FROM turn_usage_items
        WHERE started_at >= ? AND kind IN ('tool', 'skill_activation', 'skill_execution')
        ORDER BY item_id ASC
      `, cutoff);
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
    const totalRow = this.getPrepared<{ count: number }>(
      `SELECT COUNT(*) AS count FROM agent_sessions ${where}`,
      ...whereArgs,
    );
    const rows = this.allPrepared<Record<string, unknown>>(`
      SELECT session_id, source, workspace_server_scope, workspace_directory, workspace_worktree,
             model, reasoning_effort, model_config, created_at, last_active_at,
             message_count, tool_call_count, input_tokens, output_tokens, title, api_call_count
      FROM agent_sessions ${where}
      ORDER BY last_active_at DESC, created_at DESC, session_id ASC LIMIT ? OFFSET ?
    `, ...whereArgs, limit, offset);
    const summary = this.getPrepared<Record<string, number>>(`
      SELECT COUNT(*) AS total_sessions, COALESCE(SUM(tool_call_count), 0) AS tool_call_count,
             COALESCE(SUM(input_tokens + output_tokens), 0) AS token_count FROM agent_sessions
    `);
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
    const safeSessionId = text(sessionId);
    const exists = this.getPrepared<{ present: number }>(
      "SELECT 1 AS present FROM agent_sessions WHERE session_id = ?",
      safeSessionId,
    );
    if (!exists) return undefined;
    const display = await this.loadTranscriptDisplayPage(safeSessionId, options);
    const row = this.getPrepared<Record<string, unknown>>(`
      SELECT session_id, source, workspace_server_scope, workspace_directory, workspace_worktree,
             model, reasoning_effort, model_config, created_at, last_active_at,
             message_count, tool_call_count, input_tokens, output_tokens, title, api_call_count
      FROM agent_sessions WHERE session_id = ?
    `, safeSessionId);
    if (!row) return undefined;
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

  private allPrepared<T>(sql: string, ...bindings: SQLQueryBindings[]): T[] {
    const statement = this.db().prepare<T, SQLQueryBindings[]>(sql);
    try {
      return statement.all(...bindings);
    } finally {
      statement.finalize();
    }
  }

  private getPrepared<T>(sql: string, ...bindings: SQLQueryBindings[]): T | null {
    const statement = this.db().prepare<T, SQLQueryBindings[]>(sql);
    try {
      return statement.get(...bindings);
    } finally {
      statement.finalize();
    }
  }

  private sessionPayload(row: Record<string, unknown>): JsonObject {
    const source = parseObject(row.source);
    const workspace = this.workspaceFromRow(row);
    if (!workspace) throw new Error(`session workspace is missing: ${text(row.session_id)}`);
    return {
      session_id: text(row.session_id),
      title: text(row.title),
      source,
      workspace,
      source_summary: {
        platform: text(source.platform) || "unknown",
        chat_type: text(source.chat_type),
      },
      model: text(row.model),
      reasoning_effort: text(row.reasoning_effort),
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

  private workspaceFromRow(row: Record<string, unknown>): WorkspaceContext | undefined {
    const serverScope = text(row.workspace_server_scope);
    const directory = text(row.workspace_directory);
    const worktree = text(row.workspace_worktree);
    if (!serverScope && !directory && !worktree) return undefined;
    return workspaceContextFrom({ server_scope: serverScope, directory, worktree });
  }

  private validCacheBeforeWrite(
    sessionId: string,
    path: string,
  ): ReplayCacheEntry | undefined {
    const cached = this.replayCache.get(sessionId);
    if (!cached || cached.path !== path) return undefined;
    try {
      const fileStat = statSync(path);
      if (cached.size === fileStat.size && cached.mtimeMs === fileStat.mtimeMs) return cached;
    } catch {
      // External deletion invalidates the replay cache.
    }
    this.removeReplayCacheEntry(sessionId);
    return undefined;
  }

  private async updateCacheAfterWrite(sessionId: string, path: string, messages: RuntimeMessage[]): Promise<void> {
    const fileStat = await stat(path);
    this.installReplayCacheEntry(sessionId, path, fileStat.size, fileStat.mtimeMs, messages);
  }

  private async appendReplayCacheMessage(
    sessionId: string,
    path: string,
    cached: ReplayCacheEntry,
    message: RuntimeMessage,
  ): Promise<void> {
    const current = this.replayCache.get(sessionId);
    if (current !== cached) return;
    const messageBytes = Buffer.byteLength(JSON.stringify(message));
    const delta = cached.messages.length === 0 ? messageBytes : messageBytes + 1;
    cached.messages.push(message);
    cached.byteSize += delta;
    this.replayCacheBytes += delta;
    const fileStat = await stat(path);
    cached.size = fileStat.size;
    cached.mtimeMs = fileStat.mtimeMs;
    this.touchReplayCache(sessionId, cached);
    this.evictReplayCache();
  }

  private async refreshReplayCacheMetadata(
    sessionId: string,
    path: string,
    cached: ReplayCacheEntry,
  ): Promise<void> {
    if (this.replayCache.get(sessionId) !== cached) return;
    const fileStat = await stat(path);
    cached.size = fileStat.size;
    cached.mtimeMs = fileStat.mtimeMs;
    this.touchReplayCache(sessionId, cached);
  }

  private installReplayCacheEntry(
    sessionId: string,
    path: string,
    size: number,
    mtimeMs: number,
    messages: RuntimeMessage[],
  ): void {
    this.removeReplayCacheEntry(sessionId);
    const byteSize = Buffer.byteLength(JSON.stringify(messages));
    if (
      this.replayCacheMaxEntries === 0 ||
      this.replayCacheMaxBytes === 0 ||
      byteSize > this.replayCacheMaxBytes
    ) return;
    this.replayCache.set(sessionId, { path, size, mtimeMs, byteSize, messages });
    this.replayCacheBytes += byteSize;
    this.evictReplayCache();
  }

  private touchReplayCache(sessionId: string, entry: ReplayCacheEntry): void {
    this.replayCache.delete(sessionId);
    this.replayCache.set(sessionId, entry);
  }

  private removeReplayCacheEntry(sessionId: string): void {
    const entry = this.replayCache.get(sessionId);
    if (!entry) return;
    this.replayCache.delete(sessionId);
    this.replayCacheBytes = Math.max(0, this.replayCacheBytes - entry.byteSize);
  }

  private clearReplayCache(): void {
    this.replayCache.clear();
    this.replayCacheBytes = 0;
  }

  private evictReplayCache(): void {
    while (
      this.replayCache.size > this.replayCacheMaxEntries ||
      this.replayCacheBytes > this.replayCacheMaxBytes
    ) {
      const oldest = this.replayCache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.removeReplayCacheEntry(oldest);
    }
  }

  private enqueueKeyed<T>(
    queues: Map<string, Promise<void>>,
    key: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = queues.get(key) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const barrier = result.then(() => undefined, () => undefined);
    queues.set(key, barrier);
    void barrier.then(() => {
      if (queues.get(key) === barrier) queues.delete(key);
    });
    return result;
  }

  private enqueueSessionWrite(sessionId: string, operation: () => Promise<void>): Promise<void> {
    return this.enqueueKeyed(this.writeQueues, sessionId, operation);
  }

  private async waitForSessionWrites(sessionId: string): Promise<void> {
    await this.writeQueues.get(sessionId);
  }

  private enqueueIndexSync(sessionId: string, path: string): Promise<TranscriptFileState | undefined> {
    return this.enqueueKeyed(this.indexQueues, sessionId, () => this.syncTranscriptIndex(sessionId, path));
  }

  private async appendTranscriptEvent(sessionId: string, event: JsonObject): Promise<void> {
    const path = this.transcriptPath(sessionId);
    await mkdir(dirname(path), { recursive: true });
    let size = 0;
    try {
      size = (await stat(path)).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    let separator = "";
    if (size > 0) {
      const lastByte = await this.readByteRange(path, size - 1, size);
      if (lastByte[0] !== 0x0a) {
        const repaired = await this.repairUnterminatedTail(sessionId, path, size);
        size = repaired.size;
        separator = repaired.separator;
      }
    }
    const prefix = size === 0 ? `${JSON.stringify(transcriptHeader(sessionId))}\n` : "";
    await appendFile(path, `${separator}${prefix}${JSON.stringify(event)}\n`, "utf8");
  }

  /**
   * An interrupted append can leave the file without a trailing newline. A
   * parseable tail only lost its newline, so seal it with a separator; an
   * unparseable tail is torn, unacknowledged data and must be truncated
   * before the next event would fuse with it into one permanently corrupt
   * line.
   */
  private async repairUnterminatedTail(
    sessionId: string,
    path: string,
    size: number,
  ): Promise<{ size: number; separator: string }> {
    const tailStart = await this.lastNewlineOffset(path, size);
    const tailRaw = new TextDecoder().decode(await this.readByteRange(path, tailStart, size)).trim();
    if (tailRaw && tryParseTranscriptEvent(tailRaw)) return { size, separator: "\n" };
    await truncate(path, tailStart);
    this.logger.warn("transcript_torn_tail_truncated", {
      session_id: sessionId,
      truncated_bytes: size - tailStart,
    });
    return { size: tailStart, separator: "" };
  }

  private async lastNewlineOffset(path: string, size: number): Promise<number> {
    const chunkSize = 64 * 1024;
    let end = size;
    while (end > 0) {
      const start = Math.max(0, end - chunkSize);
      const chunk = await this.readByteRange(path, start, end);
      for (let index = chunk.length - 1; index >= 0; index -= 1) {
        if (chunk[index] === 0x0a) return start + index + 1;
      }
      end = start;
    }
    return 0;
  }

  private async catchUpTranscriptIndexes(): Promise<void> {
    const rows = this.allPrepared<{ session_id: string }>(
      "SELECT session_id FROM agent_sessions ORDER BY session_id",
    );
    for (const row of rows) {
      const sessionId = text(row.session_id);
      if (sessionId) await this.enqueueIndexSync(sessionId, this.transcriptPath(sessionId));
    }
  }

  private clearTranscriptIndex(sessionId: string): void {
    this.db().transaction(() => {
      this.db().query("DELETE FROM transcript_display_groups WHERE session_id = ?").run(sessionId);
      this.db().query("DELETE FROM transcript_file_state WHERE session_id = ?").run(sessionId);
      this.db().query(`
        UPDATE agent_sessions SET model = '', reasoning_effort = '', model_config = '{}'
        WHERE session_id = ?
      `).run(sessionId);
    })();
  }

  private async readByteRange(path: string, start: number, end: number): Promise<Uint8Array> {
    const length = Math.max(0, end - start);
    const buffer = Buffer.alloc(length);
    const handle = await open(path, "r");
    try {
      let offset = 0;
      while (offset < length) {
        const result = await handle.read(buffer, offset, length - offset, start + offset);
        if (result.bytesRead === 0) break;
        offset += result.bytesRead;
      }
      return buffer.subarray(0, offset);
    } finally {
      await handle.close();
    }
  }

  private async syncTranscriptIndex(
    sessionId: string,
    path: string,
  ): Promise<TranscriptFileState | undefined> {
    let fileStat: Awaited<ReturnType<typeof stat>>;
    try {
      fileStat = await stat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.clearTranscriptIndex(sessionId);
      this.removeReplayCacheEntry(sessionId);
      return undefined;
    }
    const rawState = this.getPrepared<Record<string, unknown>>(`
      SELECT file_size, mtime_ms, indexed_bytes, event_count, raw_message_count,
             display_group_count, last_display_kind
      FROM transcript_file_state WHERE session_id = ?
    `, sessionId);
    const state: TranscriptFileState | undefined = rawState ? {
      file_size: Number(rawState.file_size ?? 0),
      mtime_ms: Number(rawState.mtime_ms ?? 0),
      indexed_bytes: Number(rawState.indexed_bytes ?? 0),
      event_count: Number(rawState.event_count ?? 0),
      raw_message_count: Number(rawState.raw_message_count ?? 0),
      display_group_count: Number(rawState.display_group_count ?? 0),
      last_display_kind: text(rawState.last_display_kind),
    } : undefined;
    if (
      state &&
      state.indexed_bytes === fileStat.size &&
      state.file_size === fileStat.size &&
      state.mtime_ms === fileStat.mtimeMs
    ) return state;

    const rebuild = !state || state.indexed_bytes > fileStat.size || (
      state.indexed_bytes === fileStat.size && state.mtime_ms !== fileStat.mtimeMs
    );
    const start = rebuild ? 0 : state.indexed_bytes;
    const bytes = await this.readByteRange(path, start, fileStat.size);
    const scanned = scanTranscriptBuffer(bytes, start, false);
    let eventCount = rebuild ? 0 : state.event_count;
    let rawMessageCount = rebuild ? 0 : state.raw_message_count;
    let displayGroupCount = rebuild ? 0 : state.display_group_count;
    let lastDisplayKind = rebuild ? "" : state.last_display_kind;
    let latestContext: JsonObject | undefined;

    const transaction = this.db().transaction(() => {
      if (rebuild) {
        this.db().query("DELETE FROM transcript_display_groups WHERE session_id = ?").run(sessionId);
        this.db().query(`
          UPDATE agent_sessions SET model = '', reasoning_effort = '', model_config = '{}'
          WHERE session_id = ?
        `).run(sessionId);
      }
      for (const line of scanned.lines) {
        const event = line.event;
        eventCount += 1;
        if (text(event.kind) === "turn_context") latestContext = event;
        if (text(event.kind) === "message") {
          rawMessageCount += 1;
          const message = parseObject(event.message);
          const role = text(message.role).toLowerCase();
          if (role === "assistant" || role === "tool") {
            if (lastDisplayKind === "assistant_tool" && displayGroupCount > 0) {
              this.db().query(`
                UPDATE transcript_display_groups SET byte_end = ?
                WHERE session_id = ? AND group_number = ?
              `).run(line.byteEnd, sessionId, displayGroupCount - 1);
            } else {
              this.db().query(`
                INSERT INTO transcript_display_groups
                  (session_id, group_number, byte_start, byte_end, group_kind)
                VALUES (?, ?, ?, ?, 'assistant_tool')
              `).run(sessionId, displayGroupCount, line.byteStart, line.byteEnd);
              displayGroupCount += 1;
            }
            lastDisplayKind = "assistant_tool";
          } else if (role) {
            this.db().query(`
              INSERT INTO transcript_display_groups
                (session_id, group_number, byte_start, byte_end, group_kind)
              VALUES (?, ?, ?, ?, 'message')
            `).run(sessionId, displayGroupCount, line.byteStart, line.byteEnd);
            displayGroupCount += 1;
            lastDisplayKind = "message";
          }
          continue;
        }
        if (transcriptDisplayMarker(event)) {
          this.db().query(`
            INSERT INTO transcript_display_groups
              (session_id, group_number, byte_start, byte_end, group_kind)
            VALUES (?, ?, ?, ?, 'marker')
          `).run(sessionId, displayGroupCount, line.byteStart, line.byteEnd);
          displayGroupCount += 1;
          lastDisplayKind = "marker";
        }
      }
      if (latestContext) {
        const modelConfig: JsonObject = {
          provider: text(latestContext.provider),
          thinking_enabled: latestContext.thinking_enabled === true,
          provider_generation: Math.max(0, Math.trunc(Number(latestContext.provider_generation ?? 0))),
          context_window_tokens: Math.max(0, Math.trunc(Number(latestContext.context_window_tokens ?? 0))),
        };
        this.db().query(`
          UPDATE agent_sessions SET model = ?, reasoning_effort = ?, model_config = ?
          WHERE session_id = ?
        `).run(
          text(latestContext.model),
          text(latestContext.effort),
          JSON.stringify(modelConfig),
          sessionId,
        );
      }
      this.db().query(`
        INSERT INTO transcript_file_state (
          session_id, file_size, mtime_ms, indexed_bytes, event_count,
          raw_message_count, display_group_count, last_display_kind, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          file_size = excluded.file_size,
          mtime_ms = excluded.mtime_ms,
          indexed_bytes = excluded.indexed_bytes,
          event_count = excluded.event_count,
          raw_message_count = excluded.raw_message_count,
          display_group_count = excluded.display_group_count,
          last_display_kind = excluded.last_display_kind,
          updated_at = excluded.updated_at
      `).run(
        sessionId,
        fileStat.size,
        fileStat.mtimeMs,
        scanned.completeBytes,
        eventCount,
        rawMessageCount,
        displayGroupCount,
        lastDisplayKind,
        Date.now() / 1_000,
      );
    });
    transaction();
    return {
      file_size: fileStat.size,
      mtime_ms: fileStat.mtimeMs,
      indexed_bytes: scanned.completeBytes,
      event_count: eventCount,
      raw_message_count: rawMessageCount,
      display_group_count: displayGroupCount,
      last_display_kind: lastDisplayKind,
    };
  }

  private async readIndexedDisplayPage(
    sessionId: string,
    path: string,
    state: TranscriptFileState,
    options: DashboardSessionPageOptions,
  ): Promise<TranscriptDisplayPage> {
    const limit = Math.max(1, Math.min(Math.trunc(options.limit), 200));
    const total = state.display_group_count;
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const currentPage = options.page === undefined
      ? totalPages
      : Math.max(1, Math.min(Math.trunc(options.page), totalPages));
    const start = Math.min(total, (currentPage - 1) * limit);
    const end = Math.min(total, start + limit);
    const groups = this.allPrepared<{ byte_start: number; byte_end: number }>(`
      SELECT byte_start, byte_end FROM transcript_display_groups
      WHERE session_id = ? AND group_number >= ? AND group_number < ?
      ORDER BY group_number ASC
    `, sessionId, start, end);
    const messages: JsonObject[] = [];
    if (groups.length > 0) {
      const byteStart = Number(groups[0]!.byte_start);
      const byteEnd = Number(groups.at(-1)!.byte_end);
      const bytes = await this.readByteRange(path, byteStart, byteEnd);
      for (const { event } of scanTranscriptBuffer(bytes, byteStart, true).lines) {
        if (text(event.kind) === "message") {
          const message = parseObject(event.message);
          if (text(message.role)) messages.push(structuredClone(message));
          continue;
        }
        const marker = transcriptDisplayMarker(event);
        if (marker) messages.push(marker);
      }
    }
    return {
      messages,
      page: {
        total,
        raw_message_total: state.raw_message_count,
        start,
        end,
        limit,
        current_page: currentPage,
        total_pages: totalPages,
        has_previous: currentPage > 1,
        has_next: currentPage < totalPages,
      },
    };
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
    return normalizeTranscriptMessages(raw.split(/\r?\n/).filter((line) => line.trim()).map(parseObject));
  }
}
