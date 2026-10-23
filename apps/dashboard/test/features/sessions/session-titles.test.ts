import { afterEach, expect, test } from "bun:test";
import type { DashboardRpcCall, SessionPayload, SessionDetailPayload } from "@lxe/desktop-protocol";
import { callDashboard, setDashboardTransportForTests } from "../../../src/api/client";
import { projectSessionData, projectSessionTitle, clearSessionTitles } from "../../../src/api/session-titles";
import { ConversationDisplayController } from "../../../src/features/sessions/display-controller";

afterEach(() => { setDashboardTransportForTests(); clearSessionTitles(); });
const session = (title: string, version: number, id = "rename-test") => ({ session_id: id, title, title_version: version, title_source: "user" } as SessionPayload);
const detail = (row: SessionPayload) => ({ session: row, messages: [], messages_page: { group_cursors: [], total: 0, limit: 10, fetched_at: 1,
  oldest_cursor: null, newest_cursor: null, previous_cursor: null, next_cursor: null, has_previous: false, has_next: false } } as unknown as SessionDetailPayload);

test("late list and detail replies cannot overwrite a successful rename", async () => {
  let resolveList!: (value: unknown) => void, resolveDetail!: (value: unknown) => void;
  setDashboardTransportForTests({ call: (call: DashboardRpcCall) => {
    if (call.operation === "sessions.list") return new Promise(resolve => { resolveList = resolve; });
    if (call.operation === "sessions.detail") return new Promise(resolve => { resolveDetail = resolve; });
    return Promise.resolve(session("New", 3));
  } } as never);
  const list = callDashboard({ operation: "sessions.list", input: {} });
  const oldDetail = callDashboard({ operation: "sessions.detail", input: { session_id: "rename-test" } });
  const renamed = await callDashboard({ operation: "sessions.rename", input: { session_id: "rename-test", title: "New" } });
  resolveList({ items: [session("Old", 1)] }); resolveDetail(detail(session("Old", 1)));
  expect((await list).items[0]?.title).toBe("New"); expect((await oldDetail).session.title).toBe("New");
  expect(projectSessionData({ pages: [{ items: [session("Old", 2), session("Separate", 0, "other")] }] }).pages[0]?.items.map(row => row.title)).toEqual(["New", "Separate"]);
  expect(projectSessionTitle(session("Newer", 4)).title).toBe("Newer");
  expect(projectSessionTitle(renamed).title).toBe("Newer");
});

test("a selected reading window keeps its position when title metadata changes or old history arrives", () => {
  const controller = new ConversationDisplayController(); controller.select("rename-test");
  controller.receiveHistory(detail(session("Old", 1)), "latest");
  controller.setFollowing(false);
  const before = controller.getSnapshot();
  controller.updateTitle(session("New", 2));
  expect(controller.getSnapshot().detail?.session.title).toBe("New");
  expect(controller.getSnapshot().following).toBe(false);
  expect(controller.getSnapshot().jump).toBe(before.jump);
  controller.receiveHistory(detail(session("Old", 1)), "older");
  expect(controller.getSnapshot().detail?.session.title).toBe("New");
});
