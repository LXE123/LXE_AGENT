import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteRuntimeStore } from "../src/storage";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("SqliteRuntimeStore dashboard queries", () => {
  test("lists, searches, summarizes, and pages transcript messages", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-dashboard-store-"));
    roots.push(root);
    const store = new SqliteRuntimeStore(join(root, "agent.sqlite3"));
    await store.start();
    await store.ensureSession({ session_id: "s-1", source: { platform: "feishu", chat_type: "p2p" } });
    await store.appendMessage("s-1", { role: "user", content: "hello" });
    await store.appendMessage("s-1", { role: "assistant", content: "world" });
    await store.recordTurn("s-1", {
      turn_id: "turn-1", started_at: Date.now() / 1_000, status: "completed", elapsed_ms: 20,
      input_tokens: 7, output_tokens: 3, tool_calls: 2, api_calls: 1,
      tools: [{ name: "read", calls: 2, errors: 0, duration_ms: 5 }],
      activations: [], executions: [],
    });

    const listed = store.listSessions({ limit: 20, offset: 0, query: "s-1" });
    expect(listed.total).toBe(1);
    expect(listed.summary).toEqual({ total_sessions: 1, tool_call_count: 2, token_count: 10 });
    expect(listed.items[0]?.source_summary).toEqual({ platform: "feishu", chat_type: "p2p" });

    const detail = await store.sessionDetail("s-1", { limit: 1, page: 2 });
    expect(detail?.messages).toEqual([{ role: "assistant", content: "world" }]);
    expect(detail?.messages_page).toMatchObject({ total: 2, current_page: 2, total_pages: 2, has_previous: true, has_next: false });
    expect(await store.sessionDetail("missing", { limit: 10 })).toBeUndefined();
    expect(store.usageOverview(30)).toMatchObject({ totals: { turns: 1, tool_calls: 2, llm_calls: 1, input_tokens: 7, output_tokens: 3 } });
    expect(store.toolUsageStats(30)).toEqual([expect.objectContaining({ name: "read", calls: 2, errors: 0 })]);
    await store.stop();
  });

  test("keeps a canonical assistant/tool turn on one display page", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-dashboard-tool-page-"));
    roots.push(root);
    const store = new SqliteRuntimeStore(join(root, "agent.sqlite3"));
    await store.start();
    await store.ensureSession({ session_id: "tool-page", source: { platform: "feishu" } });
    await store.appendMessage("tool-page", { role: "user", content: "start" });
    await store.appendMessage("tool-page", {
      role: "assistant",
      content: [{ type: "tool_call", id: "call-1", name: "read", arguments: { path: "a" } }],
    });
    await store.appendMessage("tool-page", {
      role: "tool",
      content: [{ type: "tool_result", tool_call_id: "call-1", content: "a" }],
    });
    await store.appendMessage("tool-page", {
      role: "assistant",
      content: [{ type: "text", text: "done" }],
    });

    const detail = await store.sessionDetail("tool-page", { limit: 1, page: 2 });
    expect(detail?.messages).toEqual([
      expect.objectContaining({ role: "assistant" }),
      expect.objectContaining({ role: "tool" }),
      expect.objectContaining({ role: "assistant" }),
    ]);
    expect(detail?.messages_page).toEqual({
      total: 2,
      raw_message_total: 4,
      start: 1,
      end: 2,
      limit: 1,
      current_page: 2,
      total_pages: 2,
      has_previous: true,
      has_next: false,
    });
    await store.stop();
  });

  test("reads immutable transcript events instead of compacted model replay", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-dashboard-transcript-page-"));
    roots.push(root);
    const store = new SqliteRuntimeStore(join(root, "agent.sqlite3"));
    await store.start();
    await store.ensureSession({ session_id: "compacted", source: { platform: "feishu" } });
    await store.appendMessage("compacted", { role: "user", content: "old question" });
    await store.appendMessage("compacted", { role: "assistant", content: "old answer" });
    await store.replaceMessages("compacted", [{ role: "user", content: "model summary" }], "compaction", {
      compacted_count: 2,
    });
    await store.appendMessage("compacted", { role: "user", content: "after compaction" });

    expect(await store.loadMessages("compacted")).toEqual([
      { role: "user", content: "model summary" },
      { role: "user", content: "after compaction" },
    ]);
    const detail = await store.sessionDetail("compacted", { limit: 10 });
    expect(detail?.messages).toEqual([
      { role: "user", content: "old question" },
      { role: "assistant", content: "old answer" },
      { role: "system", content: "[上下文已压缩：2 条消息 → 摘要]" },
      { role: "user", content: "after compaction" },
    ]);
    expect(detail?.messages_page).toMatchObject({ total: 4, raw_message_total: 3 });

    await store.resetContext("compacted", "context_reset");
    await store.resetContext("compacted", "memory_clear");
    const markers = (await store.loadTranscriptDisplayPage("compacted", { limit: 20 })).messages
      .filter((message) => message.role === "system")
      .map((message) => message.content);
    expect(markers).toEqual([
      "[上下文已压缩：2 条消息 → 摘要]",
      "[上下文已重置]",
      "[上下文记忆已清空]",
    ]);

    await store.ensureSession({ session_id: "missing-transcript", source: { platform: "feishu" } });
    expect((await store.sessionDetail("missing-transcript", { limit: 10 }))?.messages).toEqual([]);
    await store.stop();
  });
});
