import { expect, test } from "bun:test";
import { emptyWorkspace, workspaceGroups, workspaceLabel, workspaceName } from "../../../src/features/sessions/workspace-state";
import { readStoredExpanded } from "../../../src/shared/ui/use-stored-expanded";

test("default status, custom names and empty-directory ordering are independent of sessions", () => {
  const rows = [
    { ...emptyWorkspace("/old"), workspace_id: "old", display_name: "My work", created_at: 1, last_active_at: 100 },
    { ...emptyWorkspace("/new"), workspace_id: "new", created_at: 5 },
    { ...emptyWorkspace("/empty"), workspace_id: "empty", created_at: 200 },
  ];
  expect(workspaceGroups(rows, "/new").map(row => row.directory)).toEqual(["/new", "/empty", "/old"]);
  expect(workspaceName("/new", rows, "/new", "默认工作区")).toBe("默认工作区");
  expect(workspaceName("/old", rows, "/old", "默认工作区")).toBe("My work");
  expect(workspaceName("/old", rows, "/new", "Default workspace")).toBe("My work");
  expect(workspaceName("D:\\资料\\采购", [], "/new", "Default workspace")).toBe("采购");
  rows[1]!.display_name = "My work";
  expect(workspaceLabel("/old", rows, "/new", "Default workspace")).toBe("My work · /old");
  expect(workspaceLabel("/new", rows, "/new", "Default workspace")).toBe("My work · /new");
});

test("damaged or unavailable preference storage falls back without poisoning valid entries", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  const read = (getItem: () => string | null) => {
    Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: { getItem } } });
    return readStoredExpanded("workspaces");
  };
  try {
    expect(read(() => '{"/work":false,"/other":true,"/broken":"false"}')).toEqual({ "/work": false, "/other": true });
    for (const raw of ["{", "[]", "null", "false"]) expect(read(() => raw)).toEqual({});
    expect(read(() => { throw new Error("storage disabled"); })).toEqual({});
  } finally {
    if (original) Object.defineProperty(globalThis, "window", original);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
