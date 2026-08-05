import type { ContextMenuParams, MenuItemConstructorOptions } from "electron";

export function editableContextMenuTemplate(
  params: Pick<ContextMenuParams, "editFlags" | "isEditable">,
): MenuItemConstructorOptions[] {
  if (!params.isEditable) return [];
  return [
    { role: "cut", enabled: params.editFlags.canCut },
    { role: "copy", enabled: params.editFlags.canCopy },
    { role: "paste", enabled: params.editFlags.canPaste },
  ];
}
