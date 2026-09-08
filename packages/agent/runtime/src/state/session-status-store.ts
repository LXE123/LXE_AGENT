import type { Database } from "bun:sqlite";
import type { SessionRunPhase, SessionRunSummary, SessionRunUpdate, SessionStatusRequest } from "@lxe/protocol/session-status";

type Run = { session_id: string; turn_id: string; state: SessionRunPhase; owner: string; event_version: number; version: number; seen_version: number };
const terminal = (state: string) => ["completed", "error", "cancelled"].includes(state);

/** Durable notification facts belong to the Runtime DB, never the Gateway DB. */
export class SessionStatusStore {
  constructor(private readonly db: Database) {}
  static migrate(db: Database): void {
    db.exec(`CREATE TABLE IF NOT EXISTS agent_session_runs (
      session_id TEXT NOT NULL, turn_id TEXT NOT NULL, state TEXT NOT NULL,
      owner TEXT NOT NULL, event_version INTEGER NOT NULL, version INTEGER NOT NULL,
      seen_version INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(session_id, turn_id));
      CREATE INDEX IF NOT EXISTS idx_agent_session_runs_state ON agent_session_runs(session_id, state, version);
      CREATE TABLE IF NOT EXISTS agent_session_status_versions (
        session_id TEXT PRIMARY KEY, version INTEGER NOT NULL DEFAULT 0,
        read_version INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS agent_session_status_sequence (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL, owner TEXT NOT NULL);
      INSERT OR IGNORE INTO agent_session_status_sequence VALUES (1,0,'');`);
  }
  private bump(session: string): number {
    const { version } = this.db.query<{version:number}, []>("UPDATE agent_session_status_sequence SET version=version+1 WHERE singleton=1 RETURNING version").get()!;
    this.db.query("INSERT INTO agent_session_status_versions(session_id,version) VALUES (?,?) ON CONFLICT(session_id) DO UPDATE SET version=excluded.version").run(session,version);
    return version;
  }
  private apply(owner: string, update: SessionRunUpdate): void {
    const old = this.db.query<Run, [string,string]>("SELECT * FROM agent_session_runs WHERE session_id=? AND turn_id=?").get(update.session_id,update.turn_id);
    if (old && (terminal(old.state) || old.owner === owner && old.event_version >= update.event_version)) return;
    if (old && old.state === update.state && old.owner === owner) {
      this.db.query("UPDATE agent_session_runs SET event_version=? WHERE session_id=? AND turn_id=?").run(update.event_version,update.session_id,update.turn_id);
      return;
    }
    const version = this.bump(update.session_id);
    this.db.query(`INSERT INTO agent_session_runs(session_id,turn_id,state,owner,event_version,version) VALUES (?,?,?,?,?,?)
      ON CONFLICT(session_id,turn_id) DO UPDATE SET state=excluded.state,owner=excluded.owner,event_version=excluded.event_version,version=excluded.version`)
      .run(update.session_id,update.turn_id,update.state,owner,update.event_version,version);
  }
  request(request: SessionStatusRequest): SessionRunSummary[] {
    if (request.action === "list") return [...new Set(request.session_ids)].map(id => this.summary(id));
    const affected = new Set<string>();
    this.db.transaction(() => {
      if (request.action === "ack") {
        const row = this.db.query<Run,[string,string]>("SELECT * FROM agent_session_runs WHERE session_id=? AND turn_id=?").get(request.session_id,request.turn_id);
        if (row && row.version === request.version && row.seen_version < request.version && ["completed","error","unknown"].includes(row.state)) {
          this.db.query("UPDATE agent_session_runs SET seen_version=? WHERE session_id=? AND turn_id=?").run(request.version,request.session_id,request.turn_id);
          this.bump(request.session_id);
          // Keep a session read position plus exact per-result receipts: a newer
          // viewed success must not silently clear an older, unviewed failure.
          this.db.query("UPDATE agent_session_status_versions SET read_version=MAX(read_version,?) WHERE session_id=?").run(request.version,request.session_id);
        }
        affected.add(request.session_id);
        return;
      }
      const updates = request.action === "apply" ? request.updates : request.live;
      if (request.action === "reconcile") {
        this.db.query("UPDATE agent_session_status_sequence SET owner=? WHERE singleton=1").run(request.owner);
        const live = new Set(updates.map(u => JSON.stringify([u.session_id,u.turn_id])));
        for (const old of this.db.query<Run,[]>("SELECT * FROM agent_session_runs WHERE state IN ('queued','running','stopping')").all()) {
          if (live.has(JSON.stringify([old.session_id,old.turn_id]))) continue;
          const version = this.bump(old.session_id);
          this.db.query("UPDATE agent_session_runs SET state='unknown',version=? WHERE session_id=? AND turn_id=?").run(version,old.session_id,old.turn_id);
          affected.add(old.session_id);
        }
      }
      if (this.db.query<{owner:string},[]>("SELECT owner FROM agent_session_status_sequence WHERE singleton=1").get()!.owner !== request.owner) return;
      for (const update of updates) { this.apply(request.owner,update); affected.add(update.session_id); }
    })();
    return [...affected].map(id => this.summary(id));
  }
  private summary(session_id: string): SessionRunSummary {
    const version = this.db.query<{version:number},[string]>("SELECT version FROM agent_session_status_versions WHERE session_id=?").get(session_id)?.version ?? 0;
    const busy = this.db.query<Run,[string]>(`SELECT * FROM agent_session_runs WHERE session_id=? AND state IN ('running','stopping','queued')
      ORDER BY CASE state WHEN 'stopping' THEN 0 WHEN 'running' THEN 1 ELSE 2 END,version DESC LIMIT 1`).get(session_id);
    if (busy) return {session_id,version,state:busy.state};
    const unread = this.db.query<Run,[string]>(`SELECT * FROM agent_session_runs WHERE session_id=? AND version>seen_version AND state IN ('unknown','error','completed')
      ORDER BY CASE state WHEN 'unknown' THEN 0 WHEN 'error' THEN 1 ELSE 2 END,version DESC LIMIT 1`).get(session_id);
    if (unread) return {session_id,version,state:unread.state,result:{turn_id:unread.turn_id,version:unread.version,state:unread.state as "completed"|"error"|"unknown"}};
    const last = this.db.query<Run,[string]>("SELECT * FROM agent_session_runs WHERE session_id=? ORDER BY version DESC LIMIT 1").get(session_id);
    return {session_id,version,state:last?.state === "cancelled" ? "cancelled" : "idle"};
  }
  delete(sessionId: string): void {
    this.db.query("DELETE FROM agent_session_runs WHERE session_id=?").run(sessionId);
    this.db.query("DELETE FROM agent_session_status_versions WHERE session_id=?").run(sessionId);
  }
}
