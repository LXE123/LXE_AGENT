import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

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

  test("is registered on the main window web contents", () => {
    const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    expect(source).toMatch(/webContents\.on\("context-menu"/);
    expect(source).toMatch(/Menu\.buildFromTemplate\(template\)\.popup\(\{ window: ownerWindow \}\)/);
  });
});
