import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteRuntimeStore } from "../../src/state/storage";
import { removeTemporaryRoot } from "../temp-directory";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await removeTemporaryRoot(root); });
function databasePath() {
  const root = mkdtempSync(join(tmpdir(), "lxe-workspace-registry-"));
  roots.push(root);
  return { root, path: join(root, "agent.sqlite3") };
}

test("empty registrations, names and the former default survive restarts and last-session deletion", async () => {
  const { root, path } = databasePath();
  const a = join(root, "a"), b = join(root, "b");
  let store = new SqliteRuntimeStore(path, { legacyWorkspace: { directory: a, worktree: root } });
  await store.start();
  try {
    expect(store.listSessionWorkspaces().items).toMatchObject([{ directory: a, session_count: 0, display_name: null }]);
    const initial = store.registerWorkspace(b);
    expect(store.renameWorkspace(initial.workspace_id, "  My work  ")?.display_name).toBe("My work");
    expect(store.registerWorkspace(b)).toEqual({ ...initial, display_name: "My work" });
    store.renameWorkspace(store.registerWorkspace(a).workspace_id, "My work"); // Aliases need not be unique.
    await store.ensureSession({ session_id: "last", workspace: { directory: b, worktree: root }, source: {} });
    expect(store.listSessionWorkspaces().items.find(row => row.directory === b)?.session_count).toBe(1);
    await store.deleteSession("last");
    await store.stop();
    // Neither path exists; restoring the registry must not inspect the filesystem.
    store = new SqliteRuntimeStore(path, { legacyWorkspace: { directory: b, worktree: root } });
    await store.start();
    expect(store.listSessionWorkspaces().items).toHaveLength(2);
    expect(store.listSessionWorkspaces().items.every(row => row.display_name === "My work" && row.session_count === 0)).toBe(true);
    expect(store.renameWorkspace(initial.workspace_id, " \n ")?.display_name).toBeNull();
    expect(store.renameWorkspace(join(root, "missing"), "name")).toBeUndefined();
    await store.stop();
    store = new SqliteRuntimeStore(path);
    await store.start();
    expect(store.listSessionWorkspaces().items.find(row => row.directory === b)?.display_name).toBeNull();
    expect(store.listSessionWorkspaces().items.find(row => row.directory === a)?.display_name).toBe("My work");
  } finally { await store.stop(); }
});

test("upgrade backfills exact historical paths once, including unavailable directories", async () => {
  const { root, path } = databasePath();
  let store = new SqliteRuntimeStore(path);
  await store.start();
  const historical = join(root, "offline drive", "project");
  await store.ensureSession({ session_id: "old", workspace: { directory: historical, worktree: historical }, source: {} });
  await store.stop();
  const db = new Database(path);
  db.exec("DROP TABLE agent_workspaces; DROP INDEX idx_agent_sessions_group; ALTER TABLE agent_sessions DROP COLUMN workspace_id");
  db.query("UPDATE agent_sessions SET created_at = 12 WHERE session_id = 'old'").run();
  db.close();
  store = new SqliteRuntimeStore(path);
  await store.start();
  try {
    expect(store.listSessionWorkspaces().items).toMatchObject([{ directory: historical, created_at: 12, session_count: 1 }]);
    store.renameWorkspace(store.listSessionWorkspaces().items[0]!.workspace_id, "Offline project");
    await store.stop();
    store = new SqliteRuntimeStore(path);
    await store.start();
    expect(store.listSessionWorkspaces().items).toMatchObject([{ directory: historical, created_at: 12, display_name: "Offline project" }]);
    expect((await store.getSession("old"))?.workspace.directory).toBe(historical);
  } finally { await store.stop(); }
});

test("database failures propagate and session registration is atomic", async () => {
  const { root, path } = databasePath();
  const store = new SqliteRuntimeStore(path);
  await store.start();
  const db = new Database(path);
  try {
    store.registerWorkspace(root);
    db.exec("CREATE TRIGGER refuse_workspace_rename BEFORE UPDATE ON agent_workspaces BEGIN SELECT RAISE(ABORT, 'fixture rename denied'); END");
    expect(() => store.renameWorkspace(store.registerWorkspace(root).workspace_id, "New name")).toThrow("fixture rename denied");
    expect(store.listSessionWorkspaces().items[0]?.display_name).toBeNull();
    db.exec("CREATE TRIGGER refuse_session BEFORE INSERT ON agent_sessions BEGIN SELECT RAISE(ABORT, 'fixture session denied'); END");
    const directory = join(root, "new");
    await expect(store.ensureSession({ session_id: "failed", workspace: { directory, worktree: root }, source: {} })).rejects.toThrow("fixture session denied");
    expect(store.listSessionWorkspaces().items.map(row => row.directory)).toEqual([root]);
    db.exec("CREATE TRIGGER refuse_workspace BEFORE INSERT ON agent_workspaces BEGIN SELECT RAISE(ABORT, 'fixture registry denied'); END");
    expect(() => store.registerWorkspace(directory)).toThrow("fixture registry denied");
  } finally { db.close(); await store.stop(); }
});

test("blank admissions reuse a durable session without polluting history, counts, or old zero-message sessions", async () => {
  const { root, path } = databasePath(); const workspace = { directory: root, worktree: root };
  let store = new SqliteRuntimeStore(path, { legacyWorkspace: workspace }); await store.start();
  try {
    await store.ensureSession({ session_id: "old-empty", workspace, source: { platform: "desktop" } });
    const first = store.createBlankSession(workspace);
    expect(first.blank).toBe(true);
    const ids = await Promise.all(Array.from({ length: 12 }, async () => store.createBlankSession(workspace).session_id));
    expect(new Set(ids)).toEqual(new Set([first.session_id]));
    expect(store.listSessions({ limit: 50, offset: 0 }).items.map(s => s.session_id)).toEqual(["old-empty"]);
    expect(store.listSessionWorkspaces().items[0]?.session_count).toBe(1);
    expect(store.listSessions({ limit: 50, offset: 0, query: String(first.session_id) }).total).toBe(0);
    await store.stop(); store = new SqliteRuntimeStore(path, { legacyWorkspace: workspace }); await store.start();
    expect(store.createBlankSession(workspace).session_id).toBe(first.session_id);
    expect((await store.sessionDetail(String(first.session_id), { limit: 10 }))?.session).toMatchObject({ blank: true });
    await store.ensureSession({ session_id: String(first.session_id), workspace, source: { platform: "desktop" }, entry_text: "accepted" });
    expect(store.listSessionWorkspaces().items[0]?.session_count).toBe(2);
    expect(store.createBlankSession(workspace).session_id).not.toBe(first.session_id);
  } finally { await store.stop(); }
});
