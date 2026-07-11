import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteRuntimeStore } from "../src/storage";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("SqliteRuntimeStore", () => {
  test("replays legacy tool messages, replacements, and session_messages fallback", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-runtime-legacy-store-"));
    roots.push(root);
    const store = new SqliteRuntimeStore(join(root, "local_agent.sqlite3"));
    await store.start();

    mkdirSync(join(root, "session_messages"), { recursive: true });
    writeFileSync(join(root, "session_messages", "fallback.jsonl"), [
      JSON.stringify({ role: "assistant", content: [{ type: "tool_call", id: "call-1", name: "echo", arguments: { text: "hi" } }] }),
      JSON.stringify({ role: "tool", content: [{ type: "tool_result", tool_call_id: "call-1", content: "ok" }] }),
      "",
    ].join("\n"), "utf8");
    expect(await store.loadMessages("fallback")).toEqual([
      { role: "assistant", content: [{ type: "tool_use", id: "call-1", name: "echo", input: { text: "hi" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "ok" }] },
    ]);

    mkdirSync(join(root, "session_transcripts"), { recursive: true });
    writeFileSync(join(root, "session_transcripts", "replacement.jsonl"), [
      JSON.stringify({ kind: "message", message: { role: "user", content: "discard me" } }),
      JSON.stringify({
        kind: "compaction",
        replacement_history: [
          { role: "user", content: "summary" },
          { role: "assistant", content: [{ type: "tool_call", id: "call-2", name: "echo", arguments: {} }] },
          { role: "tool", content: [{ type: "tool_result", tool_call_id: "call-2", content: "done" }] },
        ],
      }),
      JSON.stringify({ kind: "message", message: { role: "user", content: "after" } }),
      "",
    ].join("\n"), "utf8");
    expect(await store.loadMessages("replacement")).toEqual([
      { role: "user", content: "summary" },
      { role: "assistant", content: [{ type: "tool_use", id: "call-2", name: "echo", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call-2", content: "done" }] },
      { role: "user", content: "after" },
    ]);
    await store.stop();
  });

  test("round-trips existing session, route, pending-event, and transcript shapes", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-runtime-store-"));
    roots.push(root);
    const store = new SqliteRuntimeStore(join(root, "local_agent.sqlite3"));
    await store.start();
    await store.ensureSession({ session_id: "s1", source: { platform: "feishu", chat_id: "c1" } });
    await store.upsertResponseRoute({
      response_route_id: "r1",
      platform: "feishu",
      user_id: "u1",
      conversation_id: "c1",
      source: { message_id: "m1" },
    });
    await store.appendPendingEvent("s1", { event_id: "e1", job_id: "j1", text: "done" });
    expect(await store.hasPendingEvents("s1")).toBe(true);
    expect(await store.popPendingEvents("s1")).toEqual([
      expect.objectContaining({ event_id: "e1", job_id: "j1", text: "done" }),
    ]);
    await store.appendMessage("s1", { role: "user", content: "hello" }, "turn_input");
    await store.appendMessage("s1", { role: "assistant", content: "world" }, "turn_output");
    await store.replaceMessages("s1", [
      { role: "user", content: "The conversation history was compacted: important decision" },
      { role: "assistant", content: "retained answer" },
    ], "compaction", {
      trigger: "pre_call",
      summary_text: "important decision",
      compacted_count: 2,
      before_tokens: 1000,
      after_tokens: 100,
    });
    await store.appendMessage("s1", { role: "user", content: "after compaction" }, "turn_input");
    await store.patchSessionState("s1", { browser: { session_id: "remote-1", page: 1 } });
    await store.patchSessionState("s1", { browser: { page: 2 }, amazon: { shipment_id: "FBA1" } });
    expect(await store.loadMessages("s1")).toEqual([
      { role: "user", content: "The conversation history was compacted: important decision" },
      { role: "assistant", content: "retained answer" },
      { role: "user", content: "after compaction" },
    ]);
    expect(await store.getSession("s1")).toEqual(expect.objectContaining({
      session_id: "s1",
      source: expect.objectContaining({
        tool_state: {
          browser: { session_id: "remote-1", page: 2 },
          amazon: { shipment_id: "FBA1" },
        },
      }),
    }));
    expect(await store.getResponseRoute("r1")).toEqual(expect.objectContaining({
      response_route_id: "r1",
      owner_user_id: "u1",
      conversation_id: "c1",
    }));
    await store.stop();
    const reopened = new SqliteRuntimeStore(join(root, "local_agent.sqlite3"));
    await reopened.start();
    expect(await reopened.loadMessages("s1")).toEqual([
      { role: "user", content: "The conversation history was compacted: important decision" },
      { role: "assistant", content: "retained answer" },
      { role: "user", content: "after compaction" },
    ]);
    await reopened.stop();
  });

  test("caches transcript replay, sanitizes persisted images, derives title, and invalidates external writes", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-runtime-cache-store-"));
    roots.push(root);
    const store = new SqliteRuntimeStore(join(root, "local_agent.sqlite3"));
    await store.start();
    await store.ensureSession({ session_id: "images", source: { platform: "feishu" } });
    await store.appendMessage("images", {
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
        { type: "text", text: "  第一条真实用户消息   with title  " },
      ],
    }, "turn_input");
    const transcript = join(root, "session_transcripts", "images.jsonl");
    const persisted = readFileSync(transcript, "utf8");
    expect(persisted).not.toContain("aGVsbG8=");
    expect(persisted).toContain("Image omitted from persisted transcript");
    expect(store.listSessions({ limit: 10, offset: 0 }).items[0]?.title).toBe("第一条真实用户消息 with title");

    await store.loadMessages("images");
    await store.loadMessages("images");
    expect(store.replayCacheStats()).toMatchObject({ hits: 1, misses: 1, entries: 1 });
    appendFileSync(transcript, `${JSON.stringify({ kind: "message", message: { role: "assistant", content: "external" } })}\n`, "utf8");
    expect(await store.loadMessages("images")).toEqual(expect.arrayContaining([{ role: "assistant", content: "external" }]));
    expect(store.replayCacheStats().misses).toBe(2);
    await store.stop();
  });

  test("resets context and records skill usage in explicit lifecycle transactions", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-runtime-lifecycle-store-"));
    roots.push(root);
    const store = new SqliteRuntimeStore(join(root, "local_agent.sqlite3"));
    await store.start();
    await store.ensureSession({ session_id: "s1", source: { tool_state: { browser: { page: 1 } } } });
    await store.appendPendingEvent("s1", { event_id: "e1", text: "pending" });
    expect(store.discardPendingEvents("s1")).toBe(1);
    await store.appendMessage("s1", { role: "user", content: "keep until reset" }, "turn_input");
    await store.resetContext("s1");
    expect(await store.loadMessages("s1")).toEqual([]);
    await store.recordTurn("s1", {
      turn_id: "turn-1", started_at: Date.now() / 1_000, status: "completed",
      skills: [{ name: "demo", module: "mabang_demo", calls: 1, errors: 0, duration_ms: 25 }],
    });
    expect(store.skillUsageStats(30, "demo")).toEqual([
      expect.objectContaining({ name: "demo", module: "mabang_demo", executions: 1, failures: 0, duration_ms: 25 }),
    ]);
    expect(store.usageOverview(30).totals).toEqual(expect.objectContaining({ skill_executions: 1, skill_failures: 0 }));
    store.clearSessionRuntimeState("s1");
    expect((await store.getSession("s1"))?.source.tool_state).toBeUndefined();
    await store.stop();
  });
});
