import { describe, expect, test } from "bun:test";
import type { SessionPayload } from "../../../src/api/payloads";
import { groupSidebarSessions } from "../../../src/features/sessions/model";
import { sessionBranchPath, sessionTree, type SessionBranch } from "../../../src/features/sessions/session-tree";

const session = (id: string, parent?: string, pinned = 0): SessionPayload => ({
  session_id: id, title: id, source: parent ? { fork: { session_id: parent } } : {},
  source_summary: { platform: "desktop", chat_type: "direct" },
  workspace: { directory: "/workspace", worktree: "/workspace" },
  model: "test", reasoning_effort: "", model_config: {}, pinned_at: pinned,
  created_at: 1, last_active_at: 1, message_count: 2, tool_call_count: 0,
  input_tokens: 0, output_tokens: 0, api_call_count: 0,
});
const ids = (tree: SessionBranch[]): unknown[] => tree.map(node => [node.session.session_id, ids(node.children)]);

describe("sidebar branch families", () => {
  test("groups forks even when a child precedes its parent, keeping recent families first", () => {
    const tree = sessionTree([session("child-2", "parent"), session("other"), session("child-1", "parent"), session("parent")]);
    expect(ids(tree)).toEqual([["parent", [["child-2", []], ["child-1", []]]], ["other", []]]);
  });

  test("nested forks retain their direct parent and expose the selection's ancestor path", () => {
    const tree = sessionTree([session("grandchild", "child"), session("parent"), session("child", "parent")]);
    expect(ids(tree)).toEqual([["parent", [["child", [["grandchild", []]]]]]]);
    expect(sessionBranchPath(tree, "grandchild")).toEqual(["parent", "child", "grandchild"]);
    expect(sessionBranchPath(tree, "missing")).toEqual([]);
  });

  test("missing and deleted parents do not hide children; a later page restores the family", () => {
    const child = session("child", "parent");
    expect(ids(sessionTree([child]))).toEqual([["child", []]]);
    expect(ids(sessionTree([child, session("parent")]))).toEqual([["parent", [["child", []]]]]);
  });

  test("pinning and workspace membership remain independent from fork lineage", () => {
    const rows = [session("child", "parent", 1), session("parent")];
    const groups = groupSidebarSessions(rows, false);
    expect(ids(sessionTree(groups.pinned))).toEqual([["child", []]]);
    expect(ids(sessionTree(groups.recent))).toEqual([["parent", []]]);
    const moved = { ...rows[0]!, workspace: { directory: "/other", worktree: "/other" } };
    expect(ids(sessionTree([moved, rows[1]!]))).toEqual([["child", []], ["parent", []]]);
  });

  test("pinning an intermediate branch promotes its descendants to the nearest unpinned ancestor", () => {
    const rows = [session("grandchild", "middle"), session("middle", "parent", 1), session("parent")];
    const groups = groupSidebarSessions(rows, false);
    expect(ids(sessionTree(groups.pinned, rows))).toEqual([["middle", []]]);
    expect(ids(sessionTree(groups.recent, rows))).toEqual([["parent", [["grandchild", []]]]]);
    expect(rows[0]!.source).toEqual({ fork: { session_id: "middle" } });
    const unpinned = rows.map(row => ({ ...row, pinned_at: 0 }));
    expect(ids(sessionTree(unpinned))).toEqual([["parent", [["middle", [["grandchild", []]]]]]]);
  });

  test("multiple pinned ancestors can be skipped, without joining unrelated workspaces", () => {
    const rows = [session("leaf", "middle-2"), session("middle-2", "middle-1", 2), session("middle-1", "root", 1), session("root")];
    const groups = groupSidebarSessions(rows, false);
    expect(ids(sessionTree(groups.recent, rows))).toEqual([["root", [["leaf", []]]]]);
    const moved = rows.map(row => row.session_id === "middle-2" ? { ...row, workspace: { directory: "/other", worktree: "/other" } } : row);
    expect(ids(sessionTree(groups.recent, moved))).toEqual([["leaf", []], ["root", []]]);
  });

  test("malformed source data and cycles cannot make conversations disappear", () => {
    const broken = { ...session("broken"), source: { fork: "invalid" } };
    const tree = sessionTree([session("a", "b"), session("b", "a"), session("self", "self"), broken]);
    expect(ids(tree)).toEqual([["b", [["a", []]]], ["self", []], ["broken", []]]);
  });
});
