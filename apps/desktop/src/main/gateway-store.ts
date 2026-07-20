import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  JsonObject,
  JsonValue,
  SessionWorkspaceRequest,
  WorkspaceContext,
} from "@lxe/protocol";
import {
  sameWorkspaceContext,
  SessionWorkspaceMismatchError,
  workspaceContextFrom,
} from "@lxe/core";
import type {
  DirectGatewayStorage,
  ResponseRoutePatch,
  ResponseRouteRecord,
} from "@lxe/gateway/desktop";

const text = (value: JsonValue | undefined): string => String(value ?? "").trim();
const retiredWorkspaceColumn = ["workspace", "server", "scope"].join("_");
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

type PreparedStatement = ReturnType<DatabaseSync["prepare"]>;

const withStatement = <Result>(
  database: DatabaseSync,
  sql: string,
  execute: (statement: PreparedStatement) => Result,
): Result => {
  const statement = database.prepare(sql);
  try {
    return execute(statement);
  } finally {
    const finalizable = statement as PreparedStatement & { finalize?: () => void };
    if (typeof finalizable.finalize === "function") finalizable.finalize();
  }
};

export class NodeGatewayStore implements Omit<
  DirectGatewayStorage,
  "appendPendingEvent" | "hasPendingEvents"
> {
  private database: DatabaseSync | undefined;

  constructor(readonly path: string, private readonly legacyWorkspace: WorkspaceContext) {}

  start(): void {
    if (this.database) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const database = new DatabaseSync(this.path);
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("PRAGMA busy_timeout = 5000");
    database.exec("PRAGMA journal_mode = WAL");
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(`
        CREATE TABLE IF NOT EXISTS gateway_sessions (
          session_id TEXT PRIMARY KEY,
          source TEXT NOT NULL DEFAULT '{}',
          workspace_directory TEXT NOT NULL DEFAULT '',
          workspace_worktree TEXT NOT NULL DEFAULT '',
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
      const columns = withStatement(
        database,
        "PRAGMA table_info(gateway_sessions)",
        (statement) => statement.all() as Array<{ name: string }>,
      );
      for (const [name, declaration] of [
        ["workspace_directory", "TEXT NOT NULL DEFAULT ''"],
        ["workspace_worktree", "TEXT NOT NULL DEFAULT ''"],
      ] as const) {
        if (!columns.some((column) => column.name === name)) {
          database.exec(`ALTER TABLE gateway_sessions ADD COLUMN ${name} ${declaration}`);
        }
      }
      withStatement(
        database,
        `
          UPDATE gateway_sessions SET
            workspace_directory = ?, workspace_worktree = ?
          WHERE workspace_directory = '' OR workspace_worktree = ''
        `,
        (statement) => statement.run(this.legacyWorkspace.directory, this.legacyWorkspace.worktree),
      );
      if (columns.some((column) => column.name === retiredWorkspaceColumn)) {
        database.exec(`ALTER TABLE gateway_sessions DROP COLUMN ${retiredWorkspaceColumn}`);
      }
      database.exec("COMMIT");
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch { /* Preserve the migration failure. */ }
      database.close();
      throw error;
    }
    this.database = database;
  }

  stop(): void {
    this.database?.close();
    this.database = undefined;
  }

  async ensureSession(request: SessionWorkspaceRequest): Promise<void> {
    const sessionId = text(request.session_id);
    if (!sessionId) throw new Error("session_id required");
    const workspace = workspaceContextFrom(request.workspace);
    const database = this.db();
    const existing = withStatement(
      database,
      `
        SELECT source, workspace_directory, workspace_worktree
        FROM gateway_sessions WHERE session_id = ?
      `,
      (statement) => statement.get(sessionId),
    ) as
      | { source: string; workspace_directory: string; workspace_worktree: string }
      | undefined;
    const existingWorkspace = existing ? this.workspaceFromRow(existing) : undefined;
    if (existingWorkspace && !sameWorkspaceContext(existingWorkspace, workspace)) {
      throw new SessionWorkspaceMismatchError(sessionId);
    }
    const source = { ...parseObject(existing?.source), ...objectValue(request.source) };
    const now = new Date().toISOString();
    withStatement(
      database,
      `
        INSERT INTO gateway_sessions (
          session_id, source, workspace_directory, workspace_worktree,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          source = excluded.source,
          workspace_directory = excluded.workspace_directory,
          workspace_worktree = excluded.workspace_worktree,
          updated_at = excluded.updated_at
      `,
      (statement) => statement.run(
        sessionId,
        JSON.stringify(source),
        workspace.directory,
        workspace.worktree,
        now,
        now,
      ),
    );
  }

  async getSession(sessionId: string): Promise<{
    session_id: string;
    source: JsonObject;
    workspace: WorkspaceContext;
  } | undefined> {
    const row = withStatement(
      this.db(),
      `
        SELECT session_id, source, workspace_directory, workspace_worktree
        FROM gateway_sessions WHERE session_id = ?
      `,
      (statement) => statement.get(sessionId),
    ) as {
      session_id: string;
      source: string;
      workspace_directory: string;
      workspace_worktree: string;
    } | undefined;
    if (!row) return undefined;
    const workspace = this.workspaceFromRow(row);
    if (!workspace) throw new Error(`session workspace is missing: ${row.session_id}`);
    return { session_id: row.session_id, source: parseObject(row.source), workspace };
  }

  private workspaceFromRow(row: {
    workspace_directory: string;
    workspace_worktree: string;
  }): WorkspaceContext | undefined {
    if (!row.workspace_directory && !row.workspace_worktree) return undefined;
    return workspaceContextFrom({
      directory: row.workspace_directory,
      worktree: row.workspace_worktree,
    });
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
    withStatement(
      this.db(),
      `
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
      `,
      (statement) => statement.run(
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
      ),
    );
  }

  async getResponseRoute(responseRouteId: string): Promise<ResponseRouteRecord | undefined> {
    const row = withStatement(
      this.db(),
      "SELECT * FROM response_routes WHERE response_route_id = ?",
      (statement) => statement.get(responseRouteId),
    ) as Record<string, unknown> | undefined;
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
    withStatement(
      this.db(),
      `
        UPDATE response_routes
        SET platform_message_id = ?, extra_data = ?, updated_at = ?
        WHERE response_route_id = ?
      `,
      (statement) => statement.run(
        platformMessageId,
        JSON.stringify(extraData),
        new Date().toISOString(),
        responseRouteId,
      ),
    );
  }

  private db(): DatabaseSync {
    if (!this.database) throw new Error("Gateway database is not started");
    return this.database;
  }
}
