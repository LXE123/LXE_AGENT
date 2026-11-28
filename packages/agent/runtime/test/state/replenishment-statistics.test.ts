import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { UsageStore } from "../../src/state/usage-store";

test("historical and current Skill reads aggregate while upload facts stay intact", () => {
  const db = new Database(":memory:");
  try {
    UsageStore.migrate(db);
    const now = Date.now() / 1000;
    db.run("INSERT INTO turn_usage(turn_id,session_id,started_at) VALUES ('t1','s1',?),('t2','s1',?)", [now, now]);
    const insert = db.prepare("INSERT INTO turn_usage_items(turn_id,session_id,started_at,kind,name,module,calls) VALUES (?,'s1',?,'skill_activation','demo',?,?)");
    insert.run("t1", now, "amazon_replenish", 2);
    insert.run("t1", now, "replenishment", 3);
    insert.run("t2", now, "amazon_replenish", 1);
    insert.finalize();
    const store = new UsageStore(db);
    const before = store.exportTurnUsage(30);
    expect(store.skillUsageStats(30, "demo")).toEqual([expect.objectContaining({ module: "replenishment", activations: 6 })]);
    expect(store.exportTurnUsage(30)).toEqual(before);
    expect(JSON.stringify(before)).toContain("amazon_replenish");
    expect(db.query("SELECT module FROM turn_usage_items ORDER BY item_id").all()).toEqual([
      { module: "amazon_replenish" }, { module: "replenishment" }, { module: "amazon_replenish" },
    ]);
  } finally { db.close(); }
});
