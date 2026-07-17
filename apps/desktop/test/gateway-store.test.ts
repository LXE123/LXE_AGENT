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

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const createRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "lxe-gateway-store-"));
  roots.push(root);
  return root;
};

describe("NodeGatewayStore workspace migration", () => {
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
    await store.rebindSession({
      session_id: "legacy-session",
      source: { chat_id: "chat-1" },
      workspace: firstWorkspace,
    });
    await expect(store.rebindSession({
      session_id: "legacy-session",
      source: {},
      workspace: secondWorkspace,
    })).rejects.toThrow("session workspace is immutable");
    store.stop();

    const reopened = new NodeGatewayStore(databasePath, secondWorkspace);
    reopened.start();
    expect((await reopened.getSession("legacy-session"))?.workspace).toEqual(firstWorkspace);
    reopened.stop();
  });
});
