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
    await store.recordTurn("s-1", { input_tokens: 7, output_tokens: 3, tool_calls: 2, api_calls: 1 });

    const listed = store.listSessions({ limit: 20, offset: 0, query: "s-1" });
    expect(listed.total).toBe(1);
    expect(listed.summary).toEqual({ total_sessions: 1, tool_call_count: 2, token_count: 10 });
    expect(listed.items[0]?.source_summary).toEqual({ platform: "feishu", chat_type: "p2p" });

    const detail = await store.sessionDetail("s-1", { limit: 1, page: 2 });
    expect(detail?.messages).toEqual([{ role: "assistant", content: "world" }]);
    expect(detail?.messages_page).toMatchObject({ total: 2, current_page: 2, total_pages: 2, has_previous: true, has_next: false });
    expect(await store.sessionDetail("missing", { limit: 10 })).toBeUndefined();
    await store.stop();
  });
});
