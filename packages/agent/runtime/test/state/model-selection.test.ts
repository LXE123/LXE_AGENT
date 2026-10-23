import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SqliteRuntimeStore } from "../../src/state/storage";
import type { RuntimeModelSelection } from "../../src/engine/types";

const roots: string[] = [];
const stores: SqliteRuntimeStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const first: RuntimeModelSelection = { provider: "deepseek", model: "deepseek-v4-flash", credential_source: "local", effort: "low", thinking_enabled: true };
const second: RuntimeModelSelection = { ...first, model: "deepseek-v4-pro", effort: "high", credential_source: "cloud" };
async function setup() {
  const root = mkdtempSync(join(tmpdir(), "lxe-session-model-")); roots.push(root);
  const path = join(root, "agent.sqlite3");
  const store = new SqliteRuntimeStore(path); stores.push(store); await store.start();
  for (const id of ["a", "b"]) await store.ensureSession({ session_id: id, source: {}, workspace: { directory: root, worktree: root } });
  return { root, path, store };
}
async function context(store: SqliteRuntimeStore, selection: RuntimeModelSelection, version?: number) {
  await store.appendTurnContext("a", { ...selection, turn_id: "turn", job_kind: "turn", provider_generation: 1,
    context_window_tokens: 1000, ts: 1, ...(version === undefined ? {} : { model_selection_version: version }) });
}

test("persists an unsent choice per session and rebuilds its projection after reopening", async () => {
  const { root, path, store } = await setup();
  expect(await store.setSessionModelSelection("a", first, 0)).toBe(1);
  expect(await store.setSessionModelSelection("b", second, 0)).toBe(1);
  await store.stop();
  const db = new Database(path);
  db.exec("DELETE FROM transcript_file_state; UPDATE agent_sessions SET pending_model_selection = NULL, model_selection_version = 0"); db.close();
  await store.start();
  expect((await store.getSession("a"))?.model_selection).toEqual(first);
  expect((await store.getSession("b"))?.model_selection).toEqual(second);
  expect(await store.loadMessages("a")).toEqual([]);
  expect(store.sessionMetadata("a")?.message_count).toBe(0);
  const log = readFileSync(join(root, "session_transcripts", "a.jsonl"), "utf8");
  expect(log).toContain('"kind":"model_selection"');
  expect(log).not.toContain("api_key");
});

test("an old turn cannot consume a newer choice, including a repeated identical selection", async () => {
  const { path, store } = await setup();
  await store.setSessionModelSelection("a", first, 0);
  await store.setSessionModelSelection("a", second, 1);
  await context(store, first, 1);
  expect((await store.getSession("a"))?.model_selection).toEqual(second);
  await store.setSessionModelSelection("a", second, 2);
  await context(store, second, 2);
  const db = new Database(path);
  expect(db.query("SELECT pending_model_selection FROM agent_sessions WHERE session_id = 'a'").get()).toMatchObject({ pending_model_selection: expect.any(String) });
  await context(store, second, 3);
  expect(db.query("SELECT pending_model_selection FROM agent_sessions WHERE session_id = 'a'").get()).toEqual({ pending_model_selection: null });
  db.close();
  await store.stop(); await store.start();
  expect((await store.getSession("a"))?.model_selection).toEqual(second);
  expect((await store.getSession("a"))?.model_selection_version).toBe(3);
});

test("recovers a legacy last-used selection and catches up a journal write without its SQLite update", async () => {
  const { root, store } = await setup();
  await context(store, first);
  expect((await store.getSession("a"))?.model_selection).toEqual(first);
  appendFileSync(join(root, "session_transcripts", "a.jsonl"), JSON.stringify({ kind: "model_selection", selection: second, version: 1, ts: 2 }) + "\n");
  await store.stop(); await store.start();
  expect((await store.getSession("a"))?.model_selection).toEqual(second);
});

test("serializes conflicting writes and rejects stale effort changes without appending an event", async () => {
  const { root, store } = await setup();
  const outcomes = await Promise.allSettled([
    store.setSessionModelSelection("a", first, 0), store.setSessionModelSelection("a", second, 0),
  ]);
  expect(outcomes.map(result => result.status)).toEqual(["fulfilled", "rejected"]);
  expect(String((outcomes[1] as PromiseRejectedResult).reason)).toContain("expected version 0, current 1");
  expect((await store.getSession("a"))?.model_selection).toEqual(first);
  expect(readFileSync(join(root, "session_transcripts", "a.jsonl"), "utf8").match(/"kind":"model_selection"/g)).toHaveLength(1);
  await expect(store.setSessionModelSelection("missing", first)).rejects.toThrow("session not found");
});
