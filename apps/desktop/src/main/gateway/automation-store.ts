import type { DatabaseSync } from "node:sqlite";
import type { Automation, AutomationRun } from "@lxe/desktop-protocol";
import type { AutomationStore } from "@lxe/gateway/desktop";

/** Shares Gateway's database connection; it never accesses Agent persistence. */
export class NodeAutomationStore implements AutomationStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS automations (
      id TEXT PRIMARY KEY, version INTEGER NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS automation_runs (
      id TEXT PRIMARY KEY, automation_id TEXT NOT NULL, created_at INTEGER NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS automation_runs_task ON automation_runs(automation_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS automation_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  }
  list(includeDeleted = false): Automation[] {
    const rows = this.db.prepare(`SELECT payload FROM automations ${includeDeleted ? "" : "WHERE status != 'deleted'"} ORDER BY id`).all();
    return rows.map(row => JSON.parse(String(row.payload)) as Automation);
  }
  get(id: string): Automation | undefined {
    const row = this.db.prepare("SELECT payload FROM automations WHERE id=?").get(id);
    return row ? JSON.parse(String(row.payload)) as Automation : undefined;
  }
  save(task: Automation, expectedVersion: number | null): void {
    if (expectedVersion === null) {
      this.db.prepare("INSERT INTO automations(id,version,status,payload) VALUES (?,?,?,?)").run(task.id, task.version, task.status, JSON.stringify(task));
    } else {
      const result = this.db.prepare("UPDATE automations SET version=?,status=?,payload=? WHERE id=? AND version=?")
        .run(task.version, task.status, JSON.stringify(task), task.id, expectedVersion);
      if (!result.changes) throw new Error("Task changed; refresh before editing");
    }
  }
  claim(previous: Automation, next: Automation, run: AutomationRun): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db.prepare("UPDATE automations SET version=?,status=?,payload=? WHERE id=? AND payload=?")
        .run(next.version, next.status, JSON.stringify(next), previous.id, JSON.stringify(previous));
      if (!result.changes) { this.db.exec("ROLLBACK"); return false; }
      this.db.prepare("INSERT INTO automation_runs(id,automation_id,created_at,payload) VALUES (?,?,?,?)")
        .run(run.id, run.automation_id, run.created_at, JSON.stringify(run));
      this.db.exec("COMMIT");
      return true;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  saveRun(run: AutomationRun): void {
    const result = this.db.prepare("UPDATE automation_runs SET payload=? WHERE id=?").run(JSON.stringify(run), run.id);
    if (!result.changes) throw new Error(`Dispatch record missing: ${run.id}`);
  }
  runs(id?: string, limit = 200): AutomationRun[] {
    const rows = id === undefined
      ? this.db.prepare("SELECT payload FROM automation_runs ORDER BY created_at DESC,id DESC LIMIT ?").all(limit)
      : this.db.prepare("SELECT payload FROM automation_runs WHERE automation_id=? ORDER BY created_at DESC,id DESC LIMIT ?").all(id, limit);
    return rows.map(row => JSON.parse(String(row.payload)) as AutomationRun);
  }
  setting(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM automation_settings WHERE key=?").get(key);
    return row ? String(row.value) : undefined;
  }
  setSetting(key: string, value: string): void {
    this.db.prepare("INSERT INTO automation_settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
  }
}
