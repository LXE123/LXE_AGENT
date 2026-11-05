import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { relocateStoredPath } from "@lxe/core";
import { SqliteRuntimeStore } from "./storage";
import { readMcpConfigDocument, writeMcpConfigDocument } from "../tooling/mcp/config";
import { readSkillStates } from "../tooling/skill-files";

/** Operates only on an offline COPY. Never opens the source database. */
export async function relocateAgentData(copy: string, source: string, target: string): Promise<void> {
  const relocate = (value: string) => relocateStoredPath(value, source, target);
  const skillState = join(copy, "config", "skill-states.local.json");
  if (existsSync(skillState)) {
    const disabled = Object.keys(readSkillStates(skillState)).map(relocate);
    writeFileSync(skillState, JSON.stringify({version: 1, disabled}, null, 2) + "\n");
  }
  const mcp = join(copy, "config", "mcp_servers.local.json");
  if (existsSync(mcp)) {
    const config = readMcpConfigDocument(mcp);
    const servers = config?.mcpServers ?? config?.servers;
    if (servers && typeof servers === "object") for (const server of Object.values(servers) as Record<string, unknown>[]) {
      for (const field of ["cwd", "command"]) if (typeof server[field] === "string") server[field] = relocate(server[field]);
      if (Array.isArray(server.args)) server.args = server.args.map(arg => typeof arg === "string" ? relocate(arg) : arg);
    }
    writeMcpConfigDocument(mcp, config);
  }
  const message = (value: any): void => {
    if (!value || typeof value !== "object") return;
    if (value.environmentContext) {
      for (const key of ["cwd", "worktree", "artifact_root", "user_skills_root"]) {
        if (typeof value.environmentContext[key] === "string") value.environmentContext[key] = relocate(value.environmentContext[key]);
      }
    }
    if (value.role === "compactionSummary" && value.details) {
      for (const key of ["readFiles", "modifiedFiles"]) if (Array.isArray(value.details[key])) value.details[key] = value.details[key].map(relocate);
    }
    if (Array.isArray(value.content)) for (const block of value.content) {
      if (block?.type === "local_file" && typeof block.path === "string") block.path = relocate(block.path);
    }
  };
  const transcripts = join(copy, "db", "session_transcripts");
  if (existsSync(transcripts)) for (const name of readdirSync(transcripts)) {
    if (!name.endsWith(".jsonl")) continue;
    const path = join(transcripts, name);
    const content = readFileSync(path, "utf8");
    const lines = content.split("\n").map((line) => {
      if (!line.trim()) return line;
      const event = JSON.parse(line);
      if (["artifact", "image_view"].includes(event.kind) && typeof event.path === "string") event.path = relocate(event.path);
      if (event.kind === "message") message(event.message);
      if (event.kind === "context_patch" && Array.isArray(event.insert_messages)) event.insert_messages.forEach(message);
      return JSON.stringify(event);
    });
    writeFileSync(path, lines.join("\n"));
  }
  const path = join(copy, "db", "agent.sqlite3");
  if (!existsSync(path)) return;
  const db = new Database(path, { strict: true });
  const integrity = () => {
    const rows = db.query("PRAGMA integrity_check").all() as Record<string, unknown>[];
    if (rows.length !== 1 || Object.values(rows[0]!)[0] !== "ok") throw new Error(`Agent database integrity_check: ${JSON.stringify(rows)}`);
  };
  try {
    integrity();
    db.exec("BEGIN IMMEDIATE");
    for (const [table, fields] of [["agent_workspaces", ["directory"]], ["agent_sessions", ["workspace_directory", "workspace_worktree"]]] as const) {
      const columns = db.query(`PRAGMA table_info(${table})`).all() as {name: string}[];
      for (const field of fields) if (columns.some(c => c.name === field)) {
        for (const row of db.query(`SELECT rowid AS id, ${field} AS value FROM ${table}`).all() as {id: number; value: string}[]) {
          const next = relocate(row.value);
          if (next !== row.value) db.query(`UPDATE ${table} SET ${field} = ? WHERE rowid = ?`).run(next, row.id);
        }
      }
    }
    // Byte offsets and derived paths must be rebuilt from the relocated transcripts.
    for (const table of ["transcript_file_state", "transcript_display_groups", "transcript_history_images", "transcript_image_views", "transcript_artifacts", "transcript_attachments"]) {
      if (db.query("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)) db.exec(`DELETE FROM ${table}`);
    }
    db.exec("COMMIT");
    integrity();
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally { db.close(); }
  const store = new SqliteRuntimeStore(path);
  try { await store.start(); } finally { await store.stop(); }
}
