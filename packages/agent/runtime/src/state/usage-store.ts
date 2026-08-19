import { randomUUID } from "node:crypto";
import type { Database, SQLQueryBindings } from "bun:sqlite";
import type { JsonObject } from "@lxe/protocol";
import type { RuntimeTurnUsageRecord } from "../engine/types";
import { allPrepared, clippedText, getPrepared, parseObject, text } from "./sql";

/**
 * Owns the turn_usage* tables: per-turn telemetry, tool/skill counters and the
 * cloud export cursor. Deliberately independent of session lifecycle — usage
 * rows outlive the sessions they describe so exports are never lost.
 */
export class UsageStore {
  constructor(private readonly database: Database) {}

  /**
   * Creates and migrates the usage tables. Run it inside the caller's startup
   * transaction; when agent_sessions is already present it also backfills the
   * columns that were added after those rows were written.
   */
  static migrate(database: Database): void {
    database.exec(`
      CREATE TABLE IF NOT EXISTS turn_usage (
        turn_id TEXT PRIMARY KEY,
        sequence INTEGER,
        session_id TEXT NOT NULL,
        started_at REAL NOT NULL,
        platform TEXT NOT NULL DEFAULT '',
        bot_app_id TEXT NOT NULL DEFAULT '',
        bot_id TEXT NOT NULL DEFAULT '',
        bot_name TEXT NOT NULL DEFAULT '',
        provider TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT '',
        elapsed_ms INTEGER NOT NULL DEFAULT 0,
        llm_calls INTEGER NOT NULL DEFAULT 0,
        tool_calls INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
        cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0
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
      CREATE TABLE IF NOT EXISTS turn_usage_sync_state (
        target_url TEXT PRIMARY KEY,
        acknowledged_sequence INTEGER NOT NULL DEFAULT 0,
        updated_at REAL NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS turn_usage_sequence_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        next_sequence INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_turn_usage_started_at ON turn_usage (started_at);
      CREATE INDEX IF NOT EXISTS idx_turn_usage_items_kind_name ON turn_usage_items (kind, name, started_at);
      CREATE INDEX IF NOT EXISTS idx_turn_usage_items_turn_id ON turn_usage_items (turn_id);
    `);
    const usageColumns = allPrepared<{ name: string }>(database, "PRAGMA table_info(turn_usage)");
    for (const [name, declaration] of [
      ["sequence", "INTEGER"],
      ["platform", "TEXT NOT NULL DEFAULT ''"],
      ["bot_app_id", "TEXT NOT NULL DEFAULT ''"],
      ["bot_id", "TEXT NOT NULL DEFAULT ''"],
      ["bot_name", "TEXT NOT NULL DEFAULT ''"],
      ["provider", "TEXT NOT NULL DEFAULT ''"],
      ["model", "TEXT NOT NULL DEFAULT ''"],
      ["cache_read_input_tokens", "INTEGER NOT NULL DEFAULT 0"],
      ["cache_creation_input_tokens", "INTEGER NOT NULL DEFAULT 0"],
    ] as const) {
      if (!usageColumns.some((column) => column.name === name)) {
        database.exec(`ALTER TABLE turn_usage ADD COLUMN ${name} ${declaration}`);
      }
    }
    database.exec(`
      UPDATE turn_usage SET sequence = rowid WHERE sequence IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_turn_usage_sequence ON turn_usage (sequence);
      INSERT OR IGNORE INTO turn_usage_sequence_state (singleton, next_sequence)
      SELECT 1, COALESCE(MAX(sequence), 0) + 1 FROM turn_usage;
      UPDATE turn_usage_sequence_state SET next_sequence = MAX(
        next_sequence,
        (SELECT COALESCE(MAX(sequence), 0) + 1 FROM turn_usage)
      ) WHERE singleton = 1;
    `);
    const sessionsPresent = getPrepared<{ name: string }>(
      database,
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_sessions'",
    );
    if (!sessionsPresent) return;
    database.exec(`
      UPDATE turn_usage SET
        platform = COALESCE(NULLIF(platform, ''), (
          SELECT CASE WHEN json_valid(agent_sessions.source)
            THEN COALESCE(json_extract(agent_sessions.source, '$.platform'), '') ELSE '' END
          FROM agent_sessions WHERE agent_sessions.session_id = turn_usage.session_id
        ), ''),
        bot_app_id = COALESCE(NULLIF(bot_app_id, ''), (
          SELECT CASE WHEN json_valid(agent_sessions.source)
            THEN COALESCE(json_extract(agent_sessions.source, '$.extra.bot_app_id'), '') ELSE '' END
          FROM agent_sessions WHERE agent_sessions.session_id = turn_usage.session_id
        ), ''),
        bot_id = COALESCE(NULLIF(bot_id, ''), (
          SELECT CASE WHEN json_valid(agent_sessions.source)
            THEN COALESCE(json_extract(agent_sessions.source, '$.extra.bot_id'), '') ELSE '' END
          FROM agent_sessions WHERE agent_sessions.session_id = turn_usage.session_id
        ), ''),
        bot_name = COALESCE(NULLIF(bot_name, ''), (
          SELECT CASE WHEN json_valid(agent_sessions.source)
            THEN COALESCE(json_extract(agent_sessions.source, '$.extra.bot_name'), '') ELSE '' END
          FROM agent_sessions WHERE agent_sessions.session_id = turn_usage.session_id
        ), ''),
        model = COALESCE(NULLIF(model, ''), (
          SELECT agent_sessions.model FROM agent_sessions
          WHERE agent_sessions.session_id = turn_usage.session_id
        ), '');
    `);
  }

  /**
   * Writes the turn row and its tool/skill items. Session-level counters are the
   * runtime store's business and stay there; callers that need both updated
   * atomically wrap this in their own transaction on the same connection.
   */
  recordTurn(sessionId: string, metrics: RuntimeTurnUsageRecord): void {
    const safeSessionId = text(sessionId);
    const turnId = text(metrics.turn_id) || randomUUID().replaceAll("-", "");
    const startedAt = Number(metrics.started_at ?? Date.now() / 1_000);
    const tools = Array.isArray(metrics.tools) ? metrics.tools.map(parseObject) : [];
    const activations = Array.isArray(metrics.activations) ? metrics.activations.map(parseObject) : [];
    const executions = Array.isArray(metrics.executions) ? metrics.executions.map(parseObject) : [];
    this.database.transaction(() => {
      this.database.query(`
        INSERT INTO turn_usage
          (sequence, turn_id, session_id, started_at, platform, bot_app_id, bot_id, bot_name,
           provider, model, status, elapsed_ms, llm_calls, tool_calls, input_tokens, output_tokens,
           cache_read_input_tokens, cache_creation_input_tokens)
        VALUES ((SELECT next_sequence FROM turn_usage_sequence_state WHERE singleton = 1), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(turn_id) DO UPDATE SET
          session_id = excluded.session_id,
          started_at = excluded.started_at,
          platform = excluded.platform,
          bot_app_id = excluded.bot_app_id,
          bot_id = excluded.bot_id,
          bot_name = excluded.bot_name,
          provider = excluded.provider,
          model = excluded.model,
          status = excluded.status,
          elapsed_ms = excluded.elapsed_ms,
          llm_calls = excluded.llm_calls,
          tool_calls = excluded.tool_calls,
          input_tokens = excluded.input_tokens,
          output_tokens = excluded.output_tokens,
          cache_read_input_tokens = excluded.cache_read_input_tokens,
          cache_creation_input_tokens = excluded.cache_creation_input_tokens
      `).run(
        turnId, safeSessionId, startedAt,
        clippedText(metrics.platform, 64), clippedText(metrics.bot_app_id, 256),
        clippedText(metrics.bot_id, 256), clippedText(metrics.bot_name, 256),
        clippedText(metrics.provider, 128), clippedText(metrics.model, 256),
        text(metrics.status), Number(metrics.elapsed_ms ?? 0),
        Number(metrics.api_calls ?? metrics.llm_calls ?? 0), Number(metrics.tool_calls ?? 0),
        Number(metrics.input_tokens ?? 0), Number(metrics.output_tokens ?? 0),
        Number(metrics.cache_read_input_tokens ?? 0),
        Number(metrics.cache_creation_input_tokens ?? 0),
      );
      this.database.query(`
        UPDATE turn_usage_sequence_state SET next_sequence = MAX(
          next_sequence,
          (SELECT COALESCE(MAX(sequence), 0) + 1 FROM turn_usage)
        ) WHERE singleton = 1
      `).run();
      this.database.query("DELETE FROM turn_usage_items WHERE turn_id = ?").run(turnId);
      for (const tool of tools) {
        const name = text(tool.name);
        if (!name) continue;
        this.database.query(`
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
        this.database.query(`
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
        this.database.query(`
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
    const totals = this.get<Record<string, number>>(`
      SELECT COUNT(*) AS turns, COALESCE(SUM(tool_calls), 0) AS tool_calls,
             COALESCE(SUM(llm_calls), 0) AS llm_calls, COALESCE(SUM(input_tokens), 0) AS input_tokens,
             COALESCE(SUM(output_tokens), 0) AS output_tokens,
             COALESCE(SUM(cache_read_input_tokens), 0) AS cache_read_input_tokens,
             COALESCE(SUM(cache_creation_input_tokens), 0) AS cache_creation_input_tokens,
             COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0) AS error_turns
      FROM turn_usage WHERE started_at >= ?
    `, cutoff) ?? {};
    const dailyTurns = this.all<Record<string, unknown>>(`
      SELECT date(started_at, 'unixepoch', 'localtime') AS day, COUNT(*) AS turns,
             COALESCE(SUM(tool_calls), 0) AS tool_calls
      FROM turn_usage WHERE started_at >= ? GROUP BY day ORDER BY day ASC
    `, cutoff);
    const dailyExecutions = this.all<Record<string, unknown>>(`
      SELECT date(started_at, 'unixepoch', 'localtime') AS day,
             COALESCE(SUM(calls), 0) AS executions, COALESCE(SUM(errors), 0) AS failures
      FROM turn_usage_items WHERE kind = 'skill_execution' AND started_at >= ?
      GROUP BY day ORDER BY day ASC
    `, cutoff);
    const skillTotals = this.get<Record<string, number>>(`
      SELECT COALESCE(SUM(calls), 0) AS executions, COALESCE(SUM(errors), 0) AS failures
      FROM turn_usage_items WHERE kind = 'skill_execution' AND started_at >= ?
    `, cutoff);
    const modules = this.all<Record<string, unknown>>(`
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
        cache_read_input_tokens: Number(totals.cache_read_input_tokens ?? 0),
        cache_creation_input_tokens: Number(totals.cache_creation_input_tokens ?? 0),
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
    const rows = this.all<Record<string, unknown>>(`
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
    const rows = this.all<Record<string, unknown>>(`
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
    const daily = this.all<Record<string, unknown>>(`
      SELECT date(started_at, 'unixepoch', 'localtime') AS day,
             COALESCE(SUM(CASE WHEN kind = 'skill_activation' THEN calls ELSE 0 END), 0) AS activations,
             COALESCE(SUM(CASE WHEN kind = 'skill_execution' THEN calls ELSE 0 END), 0) AS executions,
             COALESCE(SUM(CASE WHEN kind = 'skill_execution' THEN errors ELSE 0 END), 0) AS failures
      FROM turn_usage_items
      WHERE name = ? AND kind IN ('skill_activation', 'skill_execution') AND started_at >= ?
      GROUP BY day ORDER BY day ASC
    `, skillName, cutoff);
    const failures = this.all<Record<string, unknown>>(`
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
    const rows = this.all<Record<string, unknown>>(`
      SELECT turn_id, session_id, started_at, status, elapsed_ms, llm_calls, tool_calls, input_tokens, output_tokens,
             cache_read_input_tokens, cache_creation_input_tokens
      FROM turn_usage WHERE started_at >= ? ORDER BY started_at ASC LIMIT ?
    `, cutoff, Math.max(1, Math.min(Math.trunc(limit), 50_000)));
    const turns = rows.map((row) => ({
      turn_id: text(row.turn_id), session_id: text(row.session_id), started_at: Number(row.started_at ?? 0),
      status: text(row.status), elapsed_ms: Number(row.elapsed_ms ?? 0), llm_calls: Number(row.llm_calls ?? 0),
      tool_calls: Number(row.tool_calls ?? 0), input_tokens: Number(row.input_tokens ?? 0), output_tokens: Number(row.output_tokens ?? 0),
      cache_read_input_tokens: Number(row.cache_read_input_tokens ?? 0),
      cache_creation_input_tokens: Number(row.cache_creation_input_tokens ?? 0),
      items: [] as JsonObject[],
    }));
    const byId = new Map(turns.map((turn) => [turn.turn_id, turn]));
    if (turns.length > 0) {
      const items = this.all<Record<string, unknown>>(`
        SELECT item.turn_id, item.kind, item.name, item.module, item.calls, item.errors,
               item.duration_ms, item.detail
        FROM turn_usage_items AS item
        JOIN (
          SELECT turn_id FROM turn_usage
          WHERE started_at >= ? ORDER BY started_at ASC LIMIT ?
        ) AS selected ON selected.turn_id = item.turn_id
        WHERE item.kind IN ('tool', 'skill_activation', 'skill_execution')
        ORDER BY item.item_id ASC
      `, cutoff, Math.max(1, Math.min(Math.trunc(limit), 50_000)));
      for (const row of items) {
        byId.get(text(row.turn_id))?.items.push({
          kind: text(row.kind), name: text(row.name), module: text(row.module), calls: Number(row.calls ?? 0),
          errors: Number(row.errors ?? 0), duration_ms: Number(row.duration_ms ?? 0), detail: text(row.detail),
        });
      }
    }
    return turns;
  }

  exportTurnUsageBatch(
    targetUrl: string,
    cutoff: number,
    limit = 200,
  ): { turns: JsonObject[]; acknowledged_sequence: number; has_more: boolean } {
    const safeTargetUrl = text(targetUrl);
    if (!safeTargetUrl) throw new Error("turn usage sync target URL required");
    const safeCutoff = Number.isFinite(cutoff) ? cutoff : Date.now() / 1_000 - 365 * 86_400;
    const safeLimit = Math.max(1, Math.min(Math.trunc(limit), 200));
    this.database.query(`
      INSERT OR IGNORE INTO turn_usage_sync_state (target_url, acknowledged_sequence, updated_at)
      VALUES (
        ?,
        COALESCE(
          (SELECT MIN(sequence) - 1 FROM turn_usage WHERE started_at >= ?),
          (SELECT MAX(sequence) FROM turn_usage),
          0
        ),
        ?
      )
    `).run(safeTargetUrl, safeCutoff, Date.now() / 1_000);
    const state = this.get<{ acknowledged_sequence: number }>(`
      SELECT acknowledged_sequence FROM turn_usage_sync_state WHERE target_url = ?
    `, safeTargetUrl);
    const acknowledgedSequence = Number(state?.acknowledged_sequence ?? 0);
    const rows = this.all<Record<string, unknown>>(`
      SELECT sequence, turn_id, started_at, platform, bot_app_id, bot_id, bot_name,
             provider, model, status, elapsed_ms, llm_calls, tool_calls, input_tokens, output_tokens,
             cache_read_input_tokens, cache_creation_input_tokens
      FROM turn_usage
      WHERE sequence > ? AND started_at >= ?
      ORDER BY sequence ASC LIMIT ?
    `, acknowledgedSequence, safeCutoff, safeLimit);
    const turns = rows.map((row) => ({
      sequence: Number(row.sequence ?? 0),
      turn_id: clippedText(row.turn_id, 256),
      started_at: Number(row.started_at ?? 0),
      platform: clippedText(row.platform, 64),
      bot_app_id: clippedText(row.bot_app_id, 256),
      bot_id: clippedText(row.bot_id, 256),
      bot_name: clippedText(row.bot_name, 256),
      provider: clippedText(row.provider, 128),
      model: clippedText(row.model, 256),
      status: clippedText(row.status, 32),
      elapsed_ms: Number(row.elapsed_ms ?? 0),
      llm_calls: Number(row.llm_calls ?? 0),
      tool_calls: Number(row.tool_calls ?? 0),
      input_tokens: Number(row.input_tokens ?? 0),
      output_tokens: Number(row.output_tokens ?? 0),
      cache_read_input_tokens: Number(row.cache_read_input_tokens ?? 0),
      cache_creation_input_tokens: Number(row.cache_creation_input_tokens ?? 0),
      items: [] as JsonObject[],
    }));
    const byId = new Map(turns.map((turn) => [String(turn.turn_id), turn]));
    if (turns.length > 0) {
      const items = this.all<Record<string, unknown>>(`
        SELECT item.turn_id, item.kind, item.name, item.module, item.calls, item.errors,
               item.duration_ms
        FROM turn_usage_items AS item
        JOIN (
          SELECT turn_id FROM turn_usage
          WHERE sequence > ? AND started_at >= ?
          ORDER BY sequence ASC LIMIT ?
        ) AS selected ON selected.turn_id = item.turn_id
        WHERE item.kind IN ('tool', 'skill_activation', 'skill_execution')
        ORDER BY item.item_id ASC
      `, acknowledgedSequence, safeCutoff, safeLimit);
      const itemCounts = new Map<string, number>();
      for (const row of items) {
        const turnId = text(row.turn_id);
        const turn = byId.get(turnId);
        const count = itemCounts.get(turnId) ?? 0;
        if (!turn || count >= 500) continue;
        itemCounts.set(turnId, count + 1);
        turn.items.push({
          kind: clippedText(row.kind, 32),
          name: clippedText(row.name, 256),
          module: clippedText(row.module, 256),
          calls: Number(row.calls ?? 0),
          errors: Number(row.errors ?? 0),
          duration_ms: Number(row.duration_ms ?? 0),
        });
      }
    }
    const lastSequence = Number(turns.at(-1)?.sequence ?? acknowledgedSequence);
    const more = this.get<{ present: number }>(`
      SELECT 1 AS present FROM turn_usage
      WHERE sequence > ? AND started_at >= ? LIMIT 1
    `, lastSequence, safeCutoff);
    return { turns, acknowledged_sequence: acknowledgedSequence, has_more: Boolean(more?.present) };
  }

  acknowledgeTurnUsage(targetUrl: string, sequence: number): void {
    const safeTargetUrl = text(targetUrl);
    const safeSequence = Math.max(0, Math.trunc(sequence));
    const result = this.database.query(`
      UPDATE turn_usage_sync_state SET
        acknowledged_sequence = MAX(acknowledged_sequence, ?), updated_at = ?
      WHERE target_url = ?
    `).run(safeSequence, Date.now() / 1_000, safeTargetUrl);
    if (Number(result.changes ?? 0) !== 1) throw new Error(`turn usage sync target not initialized: ${safeTargetUrl}`);
  }

  turnUsageAcknowledgedSequence(targetUrl: string): number | undefined {
    const row = this.get<{ acknowledged_sequence: number }>(`
      SELECT acknowledged_sequence FROM turn_usage_sync_state WHERE target_url = ?
    `, text(targetUrl));
    return row ? Number(row.acknowledged_sequence) : undefined;
  }

  private all<T>(sql: string, ...bindings: SQLQueryBindings[]): T[] {
    return allPrepared<T>(this.database, sql, ...bindings);
  }

  private get<T>(sql: string, ...bindings: SQLQueryBindings[]): T | null {
    return getPrepared<T>(this.database, sql, ...bindings);
  }
}
