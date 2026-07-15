import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { JsonObject, JsonValue } from "@lxe/protocol";
import type {
  DirectGatewayStorage,
  ResponseRoutePatch,
  ResponseRouteRecord,
} from "@lxe/gateway/desktop";

const text = (value: JsonValue | undefined): string => String(value ?? "").trim();
const objectValue = (value: JsonValue | undefined): JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
const parseObject = (value: unknown): JsonObject => {
  try {
    const parsed: unknown = JSON.parse(String(value ?? "{}"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as JsonObject
      : {};
  } catch {
    return {};
  }
};

export class NodeGatewayStore implements Omit<
  DirectGatewayStorage,
  "popPendingEvents" | "appendPendingEvent" | "hasPendingEvents"
> {
  private database: DatabaseSync | undefined;

  constructor(readonly path: string) {}

  start(): void {
    if (this.database) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const database = new DatabaseSync(this.path);
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("PRAGMA busy_timeout = 5000");
    database.exec("PRAGMA journal_mode = WAL");
    database.exec(`
      CREATE TABLE IF NOT EXISTS gateway_sessions (
        session_id TEXT PRIMARY KEY,
        source TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
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
    `);
    this.database = database;
  }

  stop(): void {
    this.database?.close();
    this.database = undefined;
  }

  async ensureSession(request: JsonObject): Promise<void> {
    const sessionId = text(request.session_id);
    if (!sessionId) throw new Error("session_id required");
    const existing = this.db().prepare("SELECT source FROM gateway_sessions WHERE session_id = ?").get(sessionId) as
      | { source: string }
      | undefined;
    const source = { ...parseObject(existing?.source), ...objectValue(request.source) };
    const now = new Date().toISOString();
    this.db().prepare(`
      INSERT INTO gateway_sessions (session_id, source, created_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET source = excluded.source, updated_at = excluded.updated_at
    `).run(sessionId, JSON.stringify(source), now, now);
  }

  rebindSession(request: JsonObject): Promise<void> {
    return this.ensureSession(request);
  }

  async getSession(sessionId: string): Promise<{ session_id: string; source: JsonObject } | undefined> {
    const row = this.db().prepare("SELECT session_id, source FROM gateway_sessions WHERE session_id = ?")
      .get(sessionId) as { session_id: string; source: string } | undefined;
    return row ? { session_id: row.session_id, source: parseObject(row.source) } : undefined;
  }

  async upsertResponseRoute(request: JsonObject): Promise<void> {
    const responseRouteId = text(request.response_route_id);
    if (!responseRouteId) throw new Error("response_route_id required");
    const source = objectValue(request.source);
    const now = new Date().toISOString();
    const extraData = {
      ...objectValue(request.extra_data),
      ...(text(source.message_id) ? { source_message_id: text(source.message_id) } : {}),
    };
    this.db().prepare(`
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
      text(request.user_id) || text(source.user_id),
      text(request.platform) || text(source.platform) || "feishu",
      text(request.platform_message_id) || null,
      text(request.conversation_id) || text(source.chat_id) || null,
      text(request.conversation_type) || (request.is_group === true ? "2" : "1"),
      text(request.sender_nick) || null,
      JSON.stringify(extraData),
      now,
      now,
    );
  }

  async getResponseRoute(responseRouteId: string): Promise<ResponseRouteRecord | undefined> {
    const row = this.db().prepare("SELECT * FROM response_routes WHERE response_route_id = ?")
      .get(responseRouteId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      response_route_id: String(row.response_route_id ?? ""),
      owner_user_id: String(row.owner_user_id ?? ""),
      platform: String(row.platform ?? ""),
      platform_message_id: row.platform_message_id === null ? null : String(row.platform_message_id ?? ""),
      conversation_id: row.conversation_id === null ? null : String(row.conversation_id ?? ""),
      conversation_type: row.conversation_type === null ? null : String(row.conversation_type ?? ""),
      sender_nick: row.sender_nick === null ? null : String(row.sender_nick ?? ""),
      extra_data: parseObject(row.extra_data),
      created_at: row.created_at === null ? null : String(row.created_at ?? ""),
      updated_at: row.updated_at === null ? null : String(row.updated_at ?? ""),
    };
  }

  async patchResponseRoute(responseRouteId: string, update: ResponseRoutePatch): Promise<void> {
    const current = await this.getResponseRoute(responseRouteId);
    if (!current) return;
    const extraData = update.patch ? { ...current.extra_data, ...update.patch } : current.extra_data;
    const platformMessageId = update.deliveryHandle?.platform_message_id ?? current.platform_message_id;
    this.db().prepare(`
      UPDATE response_routes
      SET platform_message_id = ?, extra_data = ?, updated_at = ?
      WHERE response_route_id = ?
    `).run(platformMessageId, JSON.stringify(extraData), new Date().toISOString(), responseRouteId);
  }

  private db(): DatabaseSync {
    if (!this.database) throw new Error("Gateway database is not started");
    return this.database;
  }
}
