import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeMessage } from "../../src/engine/types";
import { InvalidTranscriptCursorError, SqliteRuntimeStore } from "../../src/state/storage";
import { testWorkspace } from "../workspace";

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
    await store.ensureSession({ workspace: testWorkspace, session_id: "s-1", source: { platform: "feishu", chat_type: "p2p" } });
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
    expect(listed.items[0]?.workspace).toEqual(testWorkspace);

    const detail = await store.sessionDetail("s-1", { limit: 1 });
    const previousCursor = String((detail?.messages_page as { previous_cursor: string }).previous_cursor);
    expect(detail).toMatchObject({ session: { workspace: testWorkspace } });
    expect(detail?.messages).toEqual([
      { display_group_id: expect.any(String), role: "assistant", content: "world" },
    ]);
    expect(new Set((detail?.messages as Array<{ display_group_id: string }>)
      .map((message) => message.display_group_id)).size).toBe(1);
    expect(detail?.messages_page).toMatchObject({
      total: 2,
      raw_message_total: 2,
      limit: 1,
      oldest_cursor: expect.any(String),
      newest_cursor: expect.any(String),
      previous_cursor: expect.any(String),
      has_previous: true,
    });
    expect((await store.sessionDetail("s-1", { limit: 1, before: previousCursor }))?.messages)
      .toEqual([{ display_group_id: expect.any(String), role: "user", content: "hello" }]);
    expect(await store.sessionDetail("missing", { limit: 10 })).toBeUndefined();
    expect(store.usageOverview(30)).toMatchObject({ totals: { turns: 1, tool_calls: 2, llm_calls: 1, input_tokens: 7, output_tokens: 3 } });
    expect(store.toolUsageStats(30)).toEqual([expect.objectContaining({ name: "read", calls: 2, errors: 0 })]);
    await store.stop();
  });

  test("keeps display cursors stable when a new latest window is created", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-dashboard-cursor-"));
    roots.push(root);
    const store = new SqliteRuntimeStore(join(root, "agent.sqlite3"));
    await store.start();
    await store.ensureSession({ workspace: testWorkspace, session_id: "cursor-session", source: { platform: "desktop" } });
    for (let index = 0; index < 10; index += 1) {
      await store.appendMessage("cursor-session", { role: "user", content: `message-${index}` });
    }
    const original = await store.sessionDetail("cursor-session", { limit: 10 });
    const originalIds = (original?.messages as Array<{ display_group_id: string }>)
      .map((message) => message.display_group_id);

    await store.appendMessage("cursor-session", { role: "user", content: "message-10" });
    const latest = await store.sessionDetail("cursor-session", { limit: 10 });
    const latestIds = (latest?.messages as Array<{ display_group_id: string }>)
      .map((message) => message.display_group_id);

    expect(latestIds.slice(0, 9)).toEqual(originalIds.slice(1));
    expect(latestIds.at(-1)).not.toBe(originalIds.at(-1));
    const previousCursor = String((latest?.messages_page as { previous_cursor: string }).previous_cursor);
    expect((await store.sessionDetail("cursor-session", { limit: 10, before: previousCursor }))?.messages)
      .toEqual([expect.objectContaining({ content: "message-0", display_group_id: originalIds[0] })]);

    await store.ensureSession({ workspace: testWorkspace, session_id: "other-session", source: { platform: "desktop" } });
    await store.appendMessage("other-session", { role: "user", content: "other" });
    await expect(store.sessionDetail("other-session", { limit: 10, before: previousCursor }))
      .rejects.toBeInstanceOf(InvalidTranscriptCursorError);
    await expect(store.sessionDetail("cursor-session", { limit: 10, before: "not-a-cursor" }))
      .rejects.toBeInstanceOf(InvalidTranscriptCursorError);
    await store.stop();
  });

  test("keeps a canonical assistant/tool turn on one display page", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-dashboard-tool-page-"));
    roots.push(root);
    const store = new SqliteRuntimeStore(join(root, "agent.sqlite3"));
    await store.start();
    await store.ensureSession({ workspace: testWorkspace, session_id: "tool-page", source: { platform: "feishu" } });
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

    const detail = await store.sessionDetail("tool-page", { limit: 1 });
    expect(detail?.messages).toEqual([
      expect.objectContaining({ display_group_id: expect.any(String), role: "assistant" }),
      expect.objectContaining({ display_group_id: expect.any(String), role: "tool" }),
      expect.objectContaining({ display_group_id: expect.any(String), role: "assistant" }),
    ]);
    expect(new Set((detail?.messages as Array<{ display_group_id: string }>)
      .map((message) => message.display_group_id)).size).toBe(1);
    expect(detail?.messages_page).toMatchObject({
      total: 2,
      raw_message_total: 4,
      limit: 1,
      oldest_cursor: expect.any(String),
      newest_cursor: expect.any(String),
      previous_cursor: expect.any(String),
      has_previous: true,
    });
    await store.stop();
  });

  test("persists artifact references outside model replay and rebuilds their index", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-dashboard-artifact-"));
    roots.push(root);
    const databasePath = join(root, "agent.sqlite3");
    const artifactPath = join(root, "artifacts", "report.xlsx");
    let store = new SqliteRuntimeStore(databasePath);
    await store.start();
    await store.ensureSession({ workspace: testWorkspace, session_id: "artifact-session", source: { platform: "desktop" } });
    await store.appendMessage("artifact-session", { role: "user", content: "create report" });
    await store.appendMessage("artifact-session", {
      role: "assistant",
      content: [{ type: "tool_call", id: "call-1", name: "report", arguments: {} }],
      artifacts: [{
        artifact_id: "forged",
        turn_id: "turn-1",
        tool_call_id: "call-1",
        name: artifactPath,
        path: artifactPath,
      }],
    } as RuntimeMessage);
    await store.appendArtifact("artifact-session", {
      artifact_id: "artifact-1",
      turn_id: "turn-1",
      tool_call_id: "call-1",
      path: artifactPath,
      name: "report.xlsx",
      ts: 123,
    });
    await store.appendArtifact("artifact-session", {
      artifact_id: "artifact-duplicate",
      turn_id: "turn-1",
      tool_call_id: "call-1",
      path: artifactPath,
      name: "ignored-name.xlsx",
      ts: 124,
    });
    await store.appendMessage("artifact-session", {
      role: "tool",
      content: [{ type: "tool_result", tool_call_id: "call-1", content: "created" }],
    });
    await store.appendMessage("artifact-session", { role: "assistant", content: "done" });

    expect(await store.loadMessages("artifact-session")).toEqual([
      { role: "user", content: "create report" },
      { role: "assistant", content: [{ type: "tool_call", id: "call-1", name: "report", arguments: {} }] },
      { role: "tool", content: [{ type: "tool_result", tool_call_id: "call-1", content: "created" }] },
      { role: "assistant", content: "done" },
    ]);
    const detail = await store.sessionDetail("artifact-session", { limit: 1 });
    const artifactGroupId = String((detail?.messages as Array<{ display_group_id: string }>)[0]?.display_group_id);
    expect(detail?.session).toMatchObject({ message_count: 4 });
    expect(detail?.messages).toEqual([
      expect.objectContaining({
        role: "assistant",
        artifacts: [{
          artifact_id: "artifact-1",
          turn_id: "turn-1",
          tool_call_id: "call-1",
          name: "report.xlsx",
        }],
      }),
      expect.objectContaining({ role: "tool" }),
      expect.objectContaining({ role: "assistant", content: "done" }),
    ]);
    expect(JSON.stringify(detail)).not.toContain(artifactPath);
    expect(await store.resolveArtifact("artifact-session", "artifact-1")).toMatchObject({ path: artifactPath });
    expect(await store.resolveArtifact("artifact-session", "artifact-duplicate")).toBeUndefined();
    expect(await store.resolveArtifact("other-session", "artifact-1")).toBeUndefined();
    await store.stop();

    rmSync(databasePath, { force: true });
    rmSync(`${databasePath}-wal`, { force: true });
    rmSync(`${databasePath}-shm`, { force: true });
    store = new SqliteRuntimeStore(databasePath);
    await store.start();
    await store.ensureSession({ workspace: testWorkspace, session_id: "artifact-session", source: { platform: "desktop" } });
    expect(await store.resolveArtifact("artifact-session", "artifact-1")).toMatchObject({ path: artifactPath });
    const rebuiltDetail = await store.sessionDetail("artifact-session", { limit: 1 });
    expect((rebuiltDetail?.messages as Array<{ display_group_id: string }>)
      .every((message) => message.display_group_id === artifactGroupId)).toBe(true);
    expect(JSON.stringify(rebuiltDetail)).not.toContain(artifactPath);
    await store.stop();
  });

  test("reads immutable transcript events instead of compacted model replay", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-dashboard-transcript-page-"));
    roots.push(root);
    const store = new SqliteRuntimeStore(join(root, "agent.sqlite3"));
    await store.start();
    await store.ensureSession({ workspace: testWorkspace, session_id: "compacted", source: { platform: "feishu" } });
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
      expect.objectContaining({ role: "user", content: "old question", display_group_id: expect.any(String) }),
      expect.objectContaining({ role: "assistant", content: "old answer", display_group_id: expect.any(String) }),
      expect.objectContaining({
        role: "system",
        content: "[上下文已压缩：2 条消息 → 摘要]",
        display_group_id: expect.any(String),
      }),
      expect.objectContaining({ role: "user", content: "after compaction", display_group_id: expect.any(String) }),
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

    await store.ensureSession({ workspace: testWorkspace, session_id: "missing-transcript", source: { platform: "feishu" } });
    expect((await store.sessionDetail("missing-transcript", { limit: 10 }))?.messages).toEqual([]);
    await store.stop();
  });
});
