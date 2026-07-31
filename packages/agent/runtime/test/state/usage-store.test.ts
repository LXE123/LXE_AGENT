import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { UsageStore } from "../../src/state/usage-store";

const usageDatabase = (): Database => {
  const database = new Database(":memory:", { create: true, strict: true });
  UsageStore.migrate(database);
  return database;
};

// Statistics queries filter on a rolling window, so fixtures must sit inside it.
const startedAt = Math.floor(Date.now() / 1_000) - 60;

describe("UsageStore", () => {
  test("migrates without agent_sessions so usage stands on its own", () => {
    const database = usageDatabase();
    try {
      const store = new UsageStore(database);
      store.recordTurn("s1", {
        turn_id: "turn-1", started_at: startedAt, status: "completed", elapsed_ms: 5,
        input_tokens: 3, output_tokens: 4, tool_calls: 1, api_calls: 1,
        tools: [{ name: "read", calls: 1, errors: 0, duration_ms: 7 }],
        activations: [], executions: [],
      });
      expect(store.toolUsageStats(30)).toEqual([
        expect.objectContaining({ name: "read", calls: 1, errors: 0, duration_ms: 7, turns: 1 }),
      ]);
    } finally {
      database.close(true);
    }
  });

  test("assigns gapless sequences and replaces items when a turn is re-recorded", () => {
    const database = usageDatabase();
    try {
      const store = new UsageStore(database);
      for (const [index, turnId] of ["turn-1", "turn-2", "turn-3"].entries()) {
        store.recordTurn("s1", {
          turn_id: turnId, started_at: startedAt + index, status: "completed", elapsed_ms: 1,
          input_tokens: 1, output_tokens: 1, tool_calls: 1, api_calls: 1,
          tools: [{ name: "read", calls: 1, errors: 0, duration_ms: 1 }],
          activations: [], executions: [],
        });
      }
      const batch = store.exportTurnUsageBatch("https://cloud.example", startedAt - 1, 10);
      expect(batch.turns.map((turn) => turn.sequence)).toEqual([1, 2, 3]);

      store.recordTurn("s1", {
        turn_id: "turn-2", started_at: startedAt + 1, status: "error", elapsed_ms: 2,
        input_tokens: 1, output_tokens: 1, tool_calls: 1, api_calls: 1,
        tools: [{ name: "write", calls: 1, errors: 1, duration_ms: 2 }],
        activations: [], executions: [],
      });
      expect(store.toolUsageStats(30)).toEqual([
        expect.objectContaining({ name: "read", calls: 2, turns: 2 }),
        expect.objectContaining({ name: "write", calls: 1, errors: 1, turns: 1 }),
      ]);
      expect(store.usageOverview(30).totals).toMatchObject({ turns: 3, error_turns: 1 });
    } finally {
      database.close(true);
    }
  });

  test("advances the export cursor only after the target acknowledges", () => {
    const database = usageDatabase();
    try {
      const store = new UsageStore(database);
      for (const [index, turnId] of ["turn-1", "turn-2", "turn-3"].entries()) {
        store.recordTurn("s1", {
          turn_id: turnId, started_at: startedAt + index, status: "completed", elapsed_ms: 1,
          input_tokens: 1, output_tokens: 1, tool_calls: 0, api_calls: 1,
          tools: [], activations: [], executions: [],
        });
      }
      const first = store.exportTurnUsageBatch("https://cloud.example", startedAt - 1, 2);
      expect(first.acknowledged_sequence).toBe(0);
      expect(first.has_more).toBe(true);
      expect(first.turns.map((turn) => turn.turn_id)).toEqual(["turn-1", "turn-2"]);

      expect(store.exportTurnUsageBatch("https://cloud.example", startedAt - 1, 2).turns
        .map((turn) => turn.turn_id)).toEqual(["turn-1", "turn-2"]);

      store.acknowledgeTurnUsage("https://cloud.example", 2);
      expect(store.turnUsageAcknowledgedSequence("https://cloud.example")).toBe(2);
      const second = store.exportTurnUsageBatch("https://cloud.example", startedAt - 1, 2);
      expect(second.turns.map((turn) => turn.turn_id)).toEqual(["turn-3"]);
      expect(second.has_more).toBe(false);

      expect(store.turnUsageAcknowledgedSequence("https://other.example")).toBeUndefined();
      expect(() => store.acknowledgeTurnUsage("https://other.example", 1))
        .toThrow("turn usage sync target not initialized: https://other.example");
    } finally {
      database.close(true);
    }
  });

  test("keeps session identifiers and command details out of the cloud batch", () => {
    const database = usageDatabase();
    try {
      const store = new UsageStore(database);
      store.recordTurn("secret-session", {
        turn_id: "turn-1", started_at: startedAt, status: "completed", elapsed_ms: 1,
        input_tokens: 1, output_tokens: 1, tool_calls: 0, api_calls: 1, tools: [],
        activations: [{ skill: "demo", module: "amazon_fba" }],
        executions: [{ skill: "demo", module: "amazon_fba", command: "fba shipment prepare-upload", success: false, duration_ms: 3 }],
      });
      const batch = store.exportTurnUsageBatch("https://cloud.example", startedAt - 1, 10);
      const serialized = JSON.stringify(batch);
      expect(serialized).not.toContain("secret-session");
      expect(serialized).not.toContain("fba shipment prepare-upload");
      expect(batch.turns[0]).toMatchObject({ turn_id: "turn-1" });

      expect(store.skillUsageDetail("demo", 30)).toMatchObject({
        name: "demo",
        recent_failures: [expect.objectContaining({
          turn_id: "turn-1", session_id: "secret-session", command: "fba shipment prepare-upload",
        })],
      });
      expect(store.skillUsageStats(30, "demo")).toEqual([expect.objectContaining({
        name: "demo", module: "amazon_fba", activations: 1, executions: 1, failures: 1, duration_ms: 3,
      })]);
    } finally {
      database.close(true);
    }
  });

  test("backfills sequences and session-derived columns for legacy rows", () => {
    const database = new Database(":memory:", { create: true, strict: true });
    try {
      database.exec(`
        CREATE TABLE agent_sessions (
          session_id TEXT PRIMARY KEY,
          source TEXT NOT NULL DEFAULT '{}',
          model TEXT NOT NULL DEFAULT ''
        );
        INSERT INTO agent_sessions (session_id, source, model)
        VALUES ('s1', '{"platform":"feishu","extra":{"bot_id":"bot-9"}}', 'deepseek-chat');
        CREATE TABLE turn_usage (
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
        INSERT INTO turn_usage (turn_id, session_id, started_at) VALUES ('legacy-turn', 's1', ${startedAt});
      `);
      UsageStore.migrate(database);
      const store = new UsageStore(database);
      const batch = store.exportTurnUsageBatch("https://cloud.example", startedAt - 1, 10);
      expect(batch.turns).toEqual([expect.objectContaining({
        sequence: 1, turn_id: "legacy-turn", platform: "feishu", bot_id: "bot-9", model: "deepseek-chat",
      })]);

      store.recordTurn("s1", {
        turn_id: "new-turn", started_at: startedAt + 1, status: "completed", elapsed_ms: 1,
        input_tokens: 0, output_tokens: 0, tool_calls: 0, api_calls: 1, tools: [], activations: [], executions: [],
      });
      expect(store.exportTurnUsageBatch("https://cloud.example", startedAt - 1, 10).turns
        .map((turn) => turn.sequence)).toEqual([1, 2]);
    } finally {
      database.close(true);
    }
  });
});
