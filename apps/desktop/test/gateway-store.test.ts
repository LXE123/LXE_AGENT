import { afterEach, describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWorkspaceContext } from "@lxe/core";

// Desktop runs this store under Electron's Node runtime. Bun's test runtime
// does not expose node:sqlite, but bun:sqlite implements the same synchronous
// constructor and statement methods used by NodeGatewayStore.
mock.module("node:sqlite", () => ({ DatabaseSync: Database }));
const { NodeGatewayStore } = await import("../src/main/gateway-store");

const roots: string[] = [];
const retiredWorkspaceColumn = ["workspace", "server", "scope"].join("_");

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const createRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "lxe-gateway-store-"));
  roots.push(root);
  return root;
};

describe("NodeGatewayStore workspace migration", () => {
  test("detaches and restores a gateway session snapshot", async () => {
    const root = createRoot();
    const directory = join(root, "workspace");
    mkdirSync(directory);
    const workspace = resolveWorkspaceContext(directory);
    const store = new NodeGatewayStore(join(root, "gateway.sqlite3"), workspace);
    store.start();
    await store.ensureSession({
      session_id: "session-delete",
      source: { platform: "feishu", chat_id: "chat-1" },
      workspace,
    });

    const snapshot = store.detachSession("session-delete");
    expect(snapshot).toMatchObject({ session_id: "session-delete" });
    expect(await store.getSession("session-delete")).toBeUndefined();
    expect(store.detachSession("missing")).toBeUndefined();

    store.restoreSession(snapshot);
    expect(await store.getSession("session-delete")).toMatchObject({
      session_id: "session-delete",
      source: { platform: "feishu", chat_id: "chat-1" },
      workspace,
    });
    store.stop();
  });

  test("binds legacy sessions once and rejects later workspace changes", async () => {
    const root = createRoot();
    const firstDirectory = join(root, "first workspace");
    const secondDirectory = join(root, "second workspace");
    mkdirSync(firstDirectory);
    mkdirSync(secondDirectory);
    const firstWorkspace = resolveWorkspaceContext(firstDirectory);
    const secondWorkspace = resolveWorkspaceContext(secondDirectory);
    const databasePath = join(root, "gateway.sqlite3");

    const legacy = new Database(databasePath);
    legacy.exec(`
      CREATE TABLE gateway_sessions (
        session_id TEXT PRIMARY KEY,
        source TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO gateway_sessions (session_id, source, created_at, updated_at)
      VALUES ('legacy-session', '{"platform":"feishu"}', '2026-01-01', '2026-01-01');
    `);
    legacy.close();

    const store = new NodeGatewayStore(databasePath, firstWorkspace);
    store.start();
    expect((await store.getSession("legacy-session"))?.workspace).toEqual(firstWorkspace);
    await store.ensureSession({
      session_id: "legacy-session",
      source: { chat_id: "chat-1" },
      workspace: firstWorkspace,
    });
    await store.upsertResponseRoute({
      response_route_id: "route-1",
      user_id: "user-1",
      platform: "feishu",
      conversation_id: "chat-1",
      source: {},
    });
    await expect(store.ensureSession({
      session_id: "legacy-session",
      source: {},
      workspace: secondWorkspace,
    })).rejects.toThrow("session workspace is immutable");
    store.stop();

    const oldDatabase = new Database(databasePath);
    const newColumns = oldDatabase.query("PRAGMA table_info(gateway_sessions)").all() as Array<{ name: string }>;
    expect(newColumns.map((column) => column.name)).toContain("workspace_directory");
    expect(newColumns.map((column) => column.name)).toContain("workspace_worktree");
    expect(newColumns.map((column) => column.name)).not.toContain(retiredWorkspaceColumn);
    oldDatabase.exec(`
      ALTER TABLE gateway_sessions
      ADD COLUMN ${retiredWorkspaceColumn} TEXT NOT NULL DEFAULT 'unexpected';
    `);
    oldDatabase.close();

    const reopened = new NodeGatewayStore(databasePath, secondWorkspace);
    reopened.start();
    expect(await reopened.getSession("legacy-session")).toEqual(expect.objectContaining({
      source: { platform: "feishu", chat_id: "chat-1" },
      workspace: firstWorkspace,
    }));
    expect(await reopened.getResponseRoute("route-1")).toEqual(expect.objectContaining({
      owner_user_id: "user-1",
      conversation_id: "chat-1",
    }));
    reopened.stop();

    const migrated = new Database(databasePath);
    const migratedColumns = migrated.query("PRAGMA table_info(gateway_sessions)").all() as Array<{ name: string }>;
    expect(migratedColumns.map((column) => column.name)).not.toContain(retiredWorkspaceColumn);
    expect(migrated.query("SELECT COUNT(*) AS count FROM response_routes").get()).toEqual({ count: 1 });
    migrated.close();

    const idempotent = new NodeGatewayStore(databasePath, secondWorkspace);
    idempotent.start();
    expect((await idempotent.getSession("legacy-session"))?.workspace).toEqual(firstWorkspace);
    idempotent.stop();
  });

  test("rolls back all workspace schema changes when the retired column cannot be dropped", () => {
    const root = createRoot();
    const directory = join(root, "workspace");
    mkdirSync(directory);
    const workspace = resolveWorkspaceContext(directory);
    const databasePath = join(root, "gateway.sqlite3");
    const legacy = new Database(databasePath);
    legacy.exec(`
      CREATE TABLE gateway_sessions (
        session_id TEXT PRIMARY KEY,
        source TEXT NOT NULL DEFAULT '{}',
        ${retiredWorkspaceColumn} TEXT NOT NULL DEFAULT 'unexpected',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_retired_workspace_column
      ON gateway_sessions (${retiredWorkspaceColumn});
      INSERT INTO gateway_sessions (session_id, source, created_at, updated_at)
      VALUES ('preserved', '{"platform":"feishu"}', '2026-01-01', '2026-01-01');
    `);
    legacy.close();

    const store = new NodeGatewayStore(databasePath, workspace);
    expect(() => store.start()).toThrow();

    const inspected = new Database(databasePath);
    const columns = inspected.query("PRAGMA table_info(gateway_sessions)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain(retiredWorkspaceColumn);
    expect(columns.map((column) => column.name)).not.toContain("workspace_directory");
    expect(columns.map((column) => column.name)).not.toContain("workspace_worktree");
    expect(inspected.query("SELECT source FROM gateway_sessions WHERE session_id = 'preserved'").get())
      .toEqual({ source: '{"platform":"feishu"}' });
    inspected.close();
  });
});
