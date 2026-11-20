import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NodeAutomationStore } from "../src/main/automation-store";
import { AutomationService } from "../../gateway/src/orchestration/automations";
import type { DatabaseSync } from "node:sqlite";

test("SQLite persists definitions, salt and immutable dispatch records; claims and edits are atomic", async () => {
  const root = mkdtempSync(join(tmpdir(), "lxe-automation-db-")), path = join(root, "gateway.sqlite3");
  let db = new Database(path); let store = new NodeAutomationStore(db as unknown as DatabaseSync);
  const service = new AutomationService({ store, execution: { ready: () => true, validate: async () => {}, blockReason: async () => null,
    submit: async (_run, current) => current(), observe: async () => "missing" } });
  try {
    service.start(); await service.tick();
    const task = await service.save({ definition: { name: "test", prompt: "report", timezone: "Asia/Shanghai", target: { mode:"new", workspace_id:"ws" }, schedule:{ kind:"interval", minutes:60 } } });
    const run = await service.runNow(task.id), salt = store.setting("jitter_salt");
    expect(store.claim(task, task, { ...run, id:"duplicate" })).toBe(false);
    expect(store.runs()).toHaveLength(1);
    service.delete(task.id, task.version); expect(store.list()).toHaveLength(0); expect(store.list(true)).toHaveLength(1);
    // Bun's default close defers releasing prepared statements; match Node's immediate close.
    await service.stop(); db.close(true); db = new Database(path); store = new NodeAutomationStore(db as unknown as DatabaseSync);
    expect(store.setting("jitter_salt")).toBe(salt); expect(store.runs(task.id)[0]).toEqual(run);
    expect(store.get(task.id)?.status).toBe("deleted");
    expect(() => store.save(task, 999)).toThrow("changed");
  } finally { await service.stop(); db.close(true); rmSync(root, {recursive:true,force:true}); }
});
