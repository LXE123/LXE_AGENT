import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteRuntimeStore } from "../src/storage";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("SqliteRuntimeStore", () => {
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
    expect(await store.loadMessages("s1")).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "world" },
    ]);
    expect(await store.getSession("s1")).toEqual(expect.objectContaining({ session_id: "s1" }));
    expect(await store.getResponseRoute("r1")).toEqual(expect.objectContaining({
      response_route_id: "r1",
      owner_user_id: "u1",
      conversation_id: "c1",
    }));
    await store.stop();
  });
});
