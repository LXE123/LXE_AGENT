import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteRuntimeStore } from "../../src/state/storage";
import { removeTemporaryRoot } from "../temp-directory";

test("workspace deletion preserves logs, pins and execution paths across resume and restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "lxe-workspace-delete-")), directory = join(root, "project"), path = join(root, "agent.sqlite3");
  mkdirSync(directory); writeFileSync(join(directory, "keep.txt"), "keep");
  const workspace = { directory, worktree: directory };
  let store = new SqliteRuntimeStore(path, { legacyWorkspace: workspace }); await store.start();
  try {
    const registration = store.listSessionWorkspaces().items[0]!;
    const blank = store.createBlankSession(workspace, registration.workspace_id);
    await store.ensureSession({ session_id: "active", source: {}, workspace });
    await store.appendMessage("active", { role: "user", content: "Original prompt" });
    store.pinSession("active", true);
    const before = await store.loadMessages("active");
    expect(store.deleteWorkspace(registration.workspace_id)).toBe(true);
    expect(store.deleteWorkspace(registration.workspace_id)).toBe(false);
    expect(store.listSessionWorkspaces().items).toEqual([]);
    expect(store.sessionMetadata("active")).toMatchObject({ workspace_id: null, workspace });
    expect(store.sessionMetadata(String(blank.session_id))).toMatchObject({ workspace_id: null, blank: true });
    expect(await store.loadMessages("active")).toEqual(before);
    expect(store.sessionMetadata("active")!.pinned_at).toBeGreaterThan(0);
    await store.ensureSession({ session_id: "active", source: {}, workspace, entry_text: "Continue" });
    await store.appendMessage("active", { role: "user", content: "Continue" });
    expect(store.listSessionWorkspaces().items).toEqual([]);
    await store.stop(); store = new SqliteRuntimeStore(path, { legacyWorkspace: workspace }); await store.start();
    expect(store.listSessionWorkspaces().items).toEqual([]);
    expect(store.listSessions({ limit: 10, offset: 0, workspace_id: null }).items.map(row => row.session_id)).toEqual(["active"]);
    expect(readFileSync(join(directory, "keep.txt"), "utf8")).toBe("keep");
    const replacement = store.registerWorkspace(directory);
    expect(replacement.workspace_id).not.toBe(registration.workspace_id);
    expect(replacement.session_count).toBe(0);
    expect(() => store.createBlankSession(workspace, registration.workspace_id)).toThrow("workspace not found");
    const nextBlank = store.createBlankSession(workspace, replacement.workspace_id);
    expect(nextBlank.session_id).not.toBe(blank.session_id);
    await store.ensureSession({ session_id: "active", source: {}, workspace });
    expect(store.sessionMetadata("active")!.workspace_id).toBeNull();
    expect(store.listSessions({ limit: 10, offset: 0, workspace_id: replacement.workspace_id }).total).toBe(0);
  } finally { await store.stop(); await removeTemporaryRoot(root); }
});

test("transaction rollback retains the entire group and unavailable directories can still be removed", async () => {
  const root = mkdtempSync(join(tmpdir(), "lxe-workspace-delete-rollback-")), path = join(root, "agent.sqlite3");
  const store = new SqliteRuntimeStore(path); await store.start();
  const db = new Database(path);
  try {
    const directory = join(root, "offline"), workspace = store.registerWorkspace(directory);
    await store.ensureSession({ session_id: "retained", source: {}, workspace: { directory, worktree: directory } });
    db.exec("CREATE TRIGGER refuse_delete BEFORE DELETE ON agent_workspaces BEGIN SELECT RAISE(ABORT, 'fixture delete denied'); END");
    expect(() => store.deleteWorkspace(workspace.workspace_id)).toThrow("fixture delete denied");
    expect(store.listSessionWorkspaces().items[0]?.workspace_id).toBe(workspace.workspace_id);
    expect(store.sessionMetadata("retained")!.workspace_id).toBe(workspace.workspace_id);
    db.exec("DROP TRIGGER refuse_delete");
    expect(store.deleteWorkspace(workspace.workspace_id)).toBe(true);
    expect(store.sessionMetadata("retained")!.workspace_id).toBeNull();
  } finally { db.close(); await store.stop(); await removeTemporaryRoot(root); }
});

test("ungrouped pagination includes newly unregistered sessions without reviving old paths", async () => {
  const root = mkdtempSync(join(tmpdir(), "lxe-ungrouped-pages-")), store = new SqliteRuntimeStore(join(root, "agent.sqlite3"));
  await store.start();
  try {
    const registration = store.registerWorkspace(root), workspace = { directory: root, worktree: root };
    for (let i = 0; i < 23; i++) await store.ensureSession({ session_id: `s-${i}`, source: {}, workspace });
    store.deleteWorkspace(registration.workspace_id);
    await store.ensureSession({ session_id: "outside", source: {}, workspace });
    const pages = [0, 10, 20].map(offset => store.listSessions({ limit: 10, offset, workspace_id: null }));
    expect(pages.map(page => page.items.length)).toEqual([10, 10, 4]);
    expect(new Set(pages.flatMap(page => page.items.map(item => item.session_id))).size).toBe(24);
    expect(store.listSessionWorkspaces().items).toEqual([]);
    expect(store.listSessions({ limit: 10, offset: 0, workspace_id: registration.workspace_id }).total).toBe(0);
  } finally { await store.stop(); await removeTemporaryRoot(root); }
});

test("existing registry migration preserves aliases and blank membership and assigns durable ids once", async () => {
  const root = mkdtempSync(join(tmpdir(), "lxe-membership-upgrade-")), path = join(root, "agent.sqlite3");
  let store = new SqliteRuntimeStore(path); await store.start();
  try {
    const registration = store.registerWorkspace(root);
    store.renameWorkspace(registration.workspace_id, "Named project");
    const blank = store.createBlankSession({ directory: root, worktree: root }, registration.workspace_id);
    store.registerWorkspace(join(root, "empty-offline"));
    await store.stop();
    const old = new Database(path);
    old.exec(`DROP INDEX idx_agent_workspaces_id; DROP INDEX idx_agent_sessions_group;
      ALTER TABLE agent_workspaces DROP COLUMN workspace_id; ALTER TABLE agent_sessions DROP COLUMN workspace_id`);
    old.close();
    store = new SqliteRuntimeStore(path); await store.start();
    const upgraded = store.listSessionWorkspaces().items.find(row => row.directory === root)!;
    expect(upgraded.workspace_id).toBeTruthy();
    expect(upgraded.display_name).toBe("Named project");
    expect(upgraded.session_count).toBe(0);
    expect(upgraded.last_active_at).toBe(Number(blank.last_active_at));
    expect(store.listSessionWorkspaces().items).toHaveLength(2);
    expect(store.sessionMetadata(String(blank.session_id))!.workspace_id).toBe(upgraded.workspace_id);
    await store.stop(); store = new SqliteRuntimeStore(path); await store.start();
    expect(store.listSessionWorkspaces().items.find(row => row.directory === root)?.workspace_id).toBe(upgraded.workspace_id);
  } finally { await store.stop(); await removeTemporaryRoot(root); }
});
