import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteRuntimeStore } from "../../src/state/storage";
import { parseTranscriptText } from "../../src/state/transcript";
import { sanitizeMessagesForProvider } from "../../src/engine/context";
import { messageFixture } from "../message-fixtures";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of cleanups.splice(0)) await fn(); });

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "lxe-turn-fork-"));
  const store = new SqliteRuntimeStore(join(root, "agent.sqlite3"));
  cleanups.push(async () => { await store.stop(); rmSync(root, { recursive: true, force: true }); });
  await store.start();
  await store.ensureSession({ session_id: "parent", source: {}, workspace: { directory: root, worktree: root } });
  const file = (id: string) => join(root, "session_transcripts", id + ".jsonl");
  const events = (id: string) => parseTranscriptText(readFileSync(file(id), "utf8"));
  return { store, file, events };
}

test("a fork copies exactly through the selected terminal node, including cancelled and failed turns", async () => {
  const { store, events } = await setup();
  await store.appendMessage("parent", { role: "user", content: "first" }, "turn_input", "one");
  await store.appendMessage("parent", { role: "assistant", content: "answer" }, "assistant_response", "one");
  await store.recordTurn("parent", { turn_id: "one", status: "completed", started_at: 1, elapsed_ms: 20,
    input_tokens: 82, output_tokens: 7, tool_calls: 0, api_calls: 1, tools: [], activations: [], executions: [] });
  await store.appendTurnEnd("parent", "one", "completed");
  await store.appendMessage("parent", { role: "user", content: "second" }, "turn_input", "two");
  await expect(store.forkSession("parent")).rejects.toThrow("not finished");
  const old = await store.forkSession("parent", "one");
  const oldId = String(old.session_id);
  const prefix = events(oldId);
  expect(prefix[0]!.fork).toEqual({ session_id: "parent", turn_id: "one", entry_id: String(prefix.at(-1)!.id) });
  expect(prefix.slice(1)).toEqual(events("parent").slice(1, prefix.length));
  expect((await store.loadMessages(oldId)).map(m => m.content)).toEqual(["first", "answer"]);
  await store.appendMessage("parent", { role: "user", content: "stopped", runtimeContextKind: "turn_aborted" }, "turn_aborted", "two");
  await store.appendTurnEnd("parent", "two", "cancelled");
  const cancelled = await store.forkSession("parent");
  await store.appendMessage("parent", { role: "user", content: "third" }, "turn_input", "three");
  await store.appendTurnError("parent", "three", "provider failed");
  await store.appendTurnEnd("parent", "three", "error");
  const failed = await store.forkSession("parent");
  expect(store.sessionMetadata("parent")!.input_tokens).toBe(82);
  expect(failed.input_tokens).toBe(0);
  expect(await store.deleteSession("parent")).toBe(true);
  await store.stop(); await store.start();
  const detail = await store.sessionDetail(String(failed.session_id), { limit: 30 });
  expect(detail?.has_forkable_turn).toBe(true);
  expect(detail?.messages).toContainEqual(expect.objectContaining({ turn: expect.objectContaining({ status: "error", forkable: true }) }));
  expect(JSON.stringify(await store.loadMessages(String(failed.session_id)))).not.toContain("provider failed");
  const nested = await store.forkSession(String(failed.session_id), "two");
  expect(await store.loadMessages(String(nested.session_id))).toEqual(await store.loadMessages(String(cancelled.session_id)));
  await store.appendMessage(oldId, { role: "user", content: "independent" }, "turn_input", "new");
  expect(events(oldId).at(-1)!.parent_id).toBe(prefix.at(-1)!.id);
});

test("the header copies the current conversation leaf, while a turn footer stops at its recorded end", async () => {
  const { store, events } = await setup();
  // Cross a snapshot write chunk. The footer must still include the entire first entry.
  const old = "x".repeat(1024 * 1024);
  await store.appendMessage("parent", { role: "user", content: old }, "turn_input", "one");
  await store.appendTurnEnd("parent", "one", "completed");
  await store.replaceMessages("parent", [{ role: "user", content: "summary" }], "compaction");
  const leaf = events("parent").at(-1)!.id;
  const fromHeader = String((await store.forkSession("parent")).session_id);
  const fromFooter = String((await store.forkSession("parent", "one")).session_id);
  expect(events(fromHeader)[0]!.fork).toMatchObject({ entry_id: String(leaf) });
  expect(await store.loadMessages(fromHeader)).toEqual([{ role: "user", content: "summary" }]);
  expect(await store.loadMessages(fromFooter)).toEqual([{ role: "user", content: old }]);
});

test("tool loads replay from the branch prefix across compaction and restart", async () => {
  const { store, events } = await setup();
  const signal = new AbortController().signal;
  const a = { server: "reports", name: "list" }, b = { name: "lookup" };
  await store.appendLoadedTools("parent", "one", [a], signal);
  await store.appendTurnEnd("parent", "one", "completed");
  const child = String((await store.forkSession("parent", "one")).session_id);
  await store.appendLoadedTools(child, "two", [b], signal);
  await store.replaceMessages(child, [{ role: "user", content: "summary" }], "compaction");
  await store.stop();
  await store.start();
  expect(await store.readLoadedTools("parent")).toEqual([a]);
  expect(await store.readLoadedTools(child)).toEqual([a, b]);
  expect(await store.loadMessages(child)).toEqual([{ role: "user", content: "summary" }]);
  expect(events(child).filter(e => e.kind === "tools_loaded").map(e => e.tools)).toEqual([[a], [b]]);
});

test("v2 first-open migration preserves batched results, compaction offsets and stable IDs", async () => {
  const { store, file, events } = await setup();
  await store.appendMessage("parent", { role: "user", content: "old" }, "turn_input", "one");
  await store.recordTurn("parent", { turn_id: "one", status: "completed", started_at: 1, elapsed_ms: 20,
    input_tokens: 2, output_tokens: 3, tool_calls: 2, api_calls: 1, tools: [], activations: [], executions: [] });
  await store.stop();
  const msg = { role: "tool" as const, content: ["a","b"].map(id => ({ type: "tool_result", tool_call_id: id, content: id })) };
  const original = [
    { kind: "transcript_header", version: 2, session_id: "parent", created_at: "x" },
    { kind: "message", message: { role: "user", content: "first" }, turn_id: "one" },
    { kind: "message", message: msg, turn_id: "one" },
    { kind: "context_patch", patch_kind: "compaction", start: 0, delete_count: 1, insert_messages: [{ role: "user", content: "summary" }] },
  ];
  writeFileSync(file("parent"), original.map(e => JSON.stringify(e)).join("\n") + "\n");
  await store.start();
  store.listSessions({ limit: 10, offset: 0, query: "" });
  expect(events("parent")).toEqual(original);
  await Promise.all([store.sessionDetail("parent", { limit: 5 }), store.loadMessages("parent")]);
  const migrated = events("parent");
  expect(migrated[0]!.version).toBe(3);
  expect(migrated.slice(1).map(({ id, parent_id, ...entry }) => entry)).toEqual(original.slice(1));
  expect(migrated.slice(1).map(e => e.parent_id)).toEqual([null, migrated[1]!.id, migrated[2]!.id]);
  const fork = await store.forkSession("parent", "one");
  expect(await store.loadMessages(String(fork.session_id))).toEqual([{ role: "user", content: "summary" }, msg]);
  await store.stop(); await store.start(); await store.getSession("parent");
  expect(events("parent")).toEqual(migrated);
});

test("provider replay skips incomplete assistant text, preserving the audit record", async () => {
  const { store, events } = await setup();
  await store.appendMessage("parent", { role: "user", content: "keep" }, "turn_input", "one");
  for (const stopReason of ["error", "aborted"] as const) {
    await store.appendMessage("parent", messageFixture({ stopReason, content: [{ type: "text", text: "unfinished" }] }), "assistant_response", "one");
  }
  await store.appendTurnEnd("parent", "one", "error");
  const fork = await store.forkSession("parent");
  expect(JSON.stringify(events(String(fork.session_id)))).toContain("unfinished");
  const replay = sanitizeMessagesForProvider(await store.loadMessages(String(fork.session_id))).messages;
  expect(replay).toEqual([{ role: "user", content: "keep" }]);
});
