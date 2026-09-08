import { expect, test } from "bun:test";
import type { SessionRunSummary } from "@lxe/protocol/session-status";
import type { SessionDetailPayload } from "../../../src/api/payloads";
import { ConversationDisplayController } from "../../../src/features/sessions/display-controller";
import { canReadSessionResult, SessionStatusCache } from "../../../src/features/sessions/session-status";

const result: SessionRunSummary = { session_id: "s", version: 4, state: "completed", result: { turn_id: "t", version: 4, state: "completed" } };
test("late snapshots, acknowledgements and old process epochs cannot replace newer notifications", () => {
  const cache = new SessionStatusCache();
  const receive = (revision: number, state: SessionRunSummary["state"], epoch = "first") => cache.receive({ epoch, revision, items: [{ session_id: "s", version: revision, state }] });
  receive(5, "completed"); receive(4, "running");
  expect(cache.getSnapshot().get("s")!.state).toBe("completed");
  receive(7, "error"); receive(6, "idle");
  expect(cache.getSnapshot().get("s")!.state).toBe("error");
  receive(0, "unknown", "restarted"); receive(100, "running");
  expect(cache.getSnapshot().get("s")!.state).toBe("unknown");
  const before = cache.getSnapshot();
  receive(0, "unknown", "restarted");
  expect(cache.getSnapshot()).toBe(before);
  cache.receive({ epoch: "restarted", revision: 1, items: [{ session_id: "second-page", state: "queued", version: 1 }] });
  expect(cache.getSnapshot().size).toBe(2);
});

test("only loaded matching terminal results in the visible focused conversation can be acknowledged", () => {
  const c = new ConversationDisplayController();
  c.select("s");
  const read = () => canReadSessionResult(result, c.getSnapshot(), true, true);
  expect(read()).toBe(false);
  const page = (state: string, turn = "t"): SessionDetailPayload => ({ session: { session_id: "s" }, messages: [{ display_group_id: "g", display_id: "answer", role: "assistant", content: "result", turn: { turn_id: turn, status: state, elapsed_ms: 10 } }], messages_page: { group_cursors: ["g"], has_previous: false, has_next: false } }) as SessionDetailPayload;
  c.receiveHistory(page("running"), "latest"); expect(read()).toBe(false);
  c.receiveHistory(page("completed", "previous-turn"), "latest"); expect(read()).toBe(false);
  c.receiveHistory(page("completed"), "latest"); expect(read()).toBe(true);
  expect(canReadSessionResult(result, c.getSnapshot(), false, true)).toBe(false);
  expect(canReadSessionResult(result, c.getSnapshot(), true, false)).toBe(false);
  expect(canReadSessionResult({ ...result, error: "SQLITE_FULL" }, c.getSnapshot(), true, true)).toBe(false);
  c.select("other"); expect(read()).toBe(false);
});

test("live result needs matching terminal status and an actual displayed assistant row", () => {
  const c = new ConversationDisplayController();
  const base = { ...c.getSnapshot(), sessionId: "s", detail: { messages: [] } as unknown as SessionDetailPayload };
  const status = { id: "status:t", groupId: "g", turnId: "t", kind: "status" as const, status: "completed", createdAt: 1 };
  const answer = { id: "answer", groupId: "g", turnId: "t", kind: "message" as const, createdAt: 1, message: { display_group_id: "g", role: "assistant", content: "result" } };
  expect(canReadSessionResult(result, { ...base, rows: [answer] }, true, true)).toBe(false);
  expect(canReadSessionResult(result, { ...base, rows: [status] }, true, true)).toBe(false);
  expect(canReadSessionResult(result, { ...base, rows: [answer, status] }, true, true)).toBe(true);
});
