import { afterEach, expect, test } from "bun:test";
import { clearWorkspaceMembership, forgetWorkspace, projectWorkspaceData } from "../../../src/api/workspace-membership";
import { recentWorkspace, workspaceGroups } from "../../../src/features/sessions/workspace-state";
import { ConversationDisplayController } from "../../../src/features/sessions/display-controller";
import type { SessionDetailPayload } from "@lxe/desktop-protocol";

afterEach(clearWorkspaceMembership);
test("late metadata cannot revive deleted groups and a new identity at the same path remains separate", () => {
  const old = { workspace_id: "old", directory: "/project", display_name: null, created_at: 1, last_active_at: 0, session_count: 1 };
  const session = { session_id: "s", workspace_id: "old", workspace: { directory: "/project" }, title: "Original" };
  forgetWorkspace("old");
  expect(projectWorkspaceData({ items: [old] })).toEqual({ items: [] });
  expect(projectWorkspaceData({ pages: [{ items: [session] }] }).pages[0]!.items[0]).toEqual({ ...session, workspace_id: null });
  expect(projectWorkspaceData({ session }).session).toEqual({ ...session, workspace_id: null });
  expect(projectWorkspaceData({ items: [{ ...old, workspace_id: "new" }] }).items).toHaveLength(1);
  expect(workspaceGroups([], "/default")).toEqual([]);
});
test("recent workspace uses last activity, falls back to creation time and breaks ties consistently", () => {
  const item = (workspace_id: string, created_at: number, last_active_at: number) => ({ workspace_id, directory: workspace_id, display_name: null, created_at, last_active_at, session_count: 0 });
  expect(recentWorkspace([item("a", 1, 9), item("b", 10, 0)])?.workspace_id).toBe("b");
  expect(recentWorkspace([item("b", 1, 9), item("a", 1, 9)])?.workspace_id).toBe("a");
  expect(recentWorkspace([])).toBeUndefined();
});

test("membership removal keeps the reading window and late history cannot rebind it", () => {
  const page = { session: { session_id: "s", workspace_id: "old", workspace: { directory: "/project", worktree: "/project" } },
    messages: [{ role: "user", content: "Retained content", display_group_id: "g", display_id: "g:0" }],
    messages_page: { group_cursors: ["g"], total: 1, raw_message_total: 1, limit: 10, fetched_at: 1,
      oldest_cursor: "g", newest_cursor: "g", previous_cursor: null, next_cursor: null, has_previous: false, has_next: false },
  } as SessionDetailPayload;
  const controller = new ConversationDisplayController(); controller.select("s");
  controller.receiveHistory(page, "latest"); controller.setFollowing(false);
  const before = controller.getSnapshot();
  forgetWorkspace("old"); controller.updateWorkspaceMembership();
  const after = controller.getSnapshot();
  expect(after.detail?.session.workspace_id).toBeNull();
  expect(after.rows).toBe(before.rows);
  expect(after.detail?.messages).toBe(before.detail?.messages);
  expect(after.following).toBe(false);
  expect(after.jump).toBe(before.jump);
  expect(after.viewKey).toBe(before.viewKey);
  controller.receiveHistory(page, "older");
  expect(controller.getSnapshot().detail?.session.workspace_id).toBeNull();
  expect(controller.getSnapshot().detail?.session.workspace).toEqual(page.session.workspace);
});
