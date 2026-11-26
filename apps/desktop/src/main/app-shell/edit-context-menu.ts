import type { ContextMenuParams, MenuItemConstructorOptions } from "electron";

export function editContextMenuTemplate(
  params: Pick<ContextMenuParams, "editFlags" | "isEditable" | "selectionText">,
): MenuItemConstructorOptions[] {
  if (!params.isEditable) {
    return params.selectionText && params.editFlags.canCopy ? [{ role: "copy" }] : [];
  }
  return [
    { role: "cut", enabled: params.editFlags.canCut },
    { role: "copy", enabled: params.editFlags.canCopy },
    { role: "paste", enabled: params.editFlags.canPaste },
  ];
}
