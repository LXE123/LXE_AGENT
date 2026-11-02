import { describe, expect, test } from "bun:test";

import { editableContextMenuTemplate } from "../src/main/edit-context-menu";

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

describe("editable context menu", () => {
  test("does not open outside editable controls", () => {
    expect(editableContextMenuTemplate({ isEditable: false, editFlags })).toEqual([]);
  });

  test("contains only native cut, copy, and paste roles with truthful states", () => {
    expect(editableContextMenuTemplate({ isEditable: true, editFlags })).toEqual([
      { role: "cut", enabled: true },
      { role: "copy", enabled: false },
      { role: "paste", enabled: true },
    ]);
  });
});
