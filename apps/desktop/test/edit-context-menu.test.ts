import { describe, expect, test } from "bun:test";

import { editContextMenuTemplate } from "../src/main/app-shell/edit-context-menu";

const editFlags = {
  canUndo: false,
  canRedo: false,
  canCut: true,
  canCopy: false,
  canPaste: true,
  canDelete: false,
  canSelectAll: true,
  canEditRichly: false,
};

describe("edit context menu", () => {
  test("offers native copy for a selection in read-only text", () => {
    const params = { isEditable: false, selectionText: "Windows x64", editFlags: { ...editFlags, canCopy: true } };
    expect(editContextMenuTemplate(params)).toEqual([{ role: "copy" }]);
    expect(editContextMenuTemplate({ ...params, selectionText: "" })).toEqual([]);
    expect(editContextMenuTemplate({ ...params, editFlags })).toEqual([]);
  });

  test("contains only native cut, copy, and paste roles with truthful states", () => {
    expect(editContextMenuTemplate({ isEditable: true, selectionText: "", editFlags })).toEqual([
      { role: "cut", enabled: true },
      { role: "copy", enabled: false },
      { role: "paste", enabled: true },
    ]);
  });
});
