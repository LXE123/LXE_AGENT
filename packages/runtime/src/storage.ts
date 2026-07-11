import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";
import type { JsonObject } from "@lxe/protocol";
import type { RuntimeMessage, RuntimeSessionRecord, RuntimeStore } from "./types";

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

const text = (value: unknown): string => String(value ?? "").trim();

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
    `);
    this.database = database;
  }

  async stop(): Promise<void> {
    this.database?.close(false);
    this.database = undefined;
  }

  async ensureSession(request: JsonObject): Promise<void> {
    const sessionId = text(request.session_id);
    if (!sessionId) throw new Error("session_id required");
    const source = parseObject(request.source);
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
    this.db().query(`
      INSERT OR IGNORE INTO agent_session_pending_events
        (session_id, event_id, job_id, created_at, text, queued_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      text(sessionId),
      text(event.event_id) || randomUUID().replaceAll("-", ""),
      text(event.job_id),
      text(event.created_at) || now,
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

  async loadMessages(sessionId: string): Promise<RuntimeMessage[]> {
    let raw: string;
    try {
      raw = readFileSync(this.transcriptPath(sessionId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    let messages: RuntimeMessage[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const event = parseObject(line);
      if (event.kind === "message") {
        const message = event.message as unknown;
        if (message !== null && typeof message === "object" && !Array.isArray(message)) {
          const candidate = message as unknown as RuntimeMessage;
          if (candidate.role === "user" || candidate.role === "assistant") messages.push(candidate);
        }
      } else if (event.kind === "legacy_import" || event.kind === "context_replacement") {
        if (Array.isArray(event.replacement_history)) {
          const replacement = event.replacement_history as unknown[];
          messages = replacement.filter((value) => {
            if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
            const role = (value as { role?: unknown }).role;
            return role === "user" || role === "assistant";
          }) as RuntimeMessage[];
        }
      }
    }
    return messages;
  }

  async appendMessage(sessionId: string, message: RuntimeMessage, reason = "runtime"): Promise<void> {
    const path = this.transcriptPath(sessionId);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify({ kind: "message", message, reason, ts: Date.now() / 1_000 })}\n`, "utf8");
    this.db().query(`
      UPDATE agent_sessions SET last_active_at = ?, message_count = message_count + 1 WHERE session_id = ?
    `).run(Date.now() / 1_000, text(sessionId));
  }

  async recordTurn(sessionId: string, metrics: JsonObject): Promise<void> {
    this.db().query(`
      UPDATE agent_sessions SET
        last_active_at = ?,
        input_tokens = input_tokens + ?,
        output_tokens = output_tokens + ?,
        tool_call_count = tool_call_count + ?,
        api_call_count = api_call_count + ?
      WHERE session_id = ?
    `).run(
      Date.now() / 1_000,
      Number(metrics.input_tokens ?? 0),
      Number(metrics.output_tokens ?? 0),
      Number(metrics.tool_calls ?? 0),
      Number(metrics.api_calls ?? 0),
      text(sessionId),
    );
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
    const messages = await this.loadMessages(text(sessionId));
    const limit = Math.max(1, Math.min(Math.trunc(options.limit), 200));
    const total = messages.length;
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const currentPage = options.page === undefined
      ? totalPages
      : Math.max(1, Math.min(Math.trunc(options.page), totalPages));
    const start = Math.min(total, (currentPage - 1) * limit);
    const end = Math.min(total, start + limit);
    return {
      session: this.sessionPayload(row),
      messages: messages.slice(start, end) as unknown as JsonObject[],
      messages_page: {
        total,
        raw_message_total: total,
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

  private transcriptPath(sessionId: string): string {
    const safe = text(sessionId).replaceAll(/[^A-Za-z0-9_.-]/g, "_");
    return join(dirname(this.path), "session_transcripts", `${safe}.jsonl`);
  }
}
