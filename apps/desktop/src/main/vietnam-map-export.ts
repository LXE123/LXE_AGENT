import type { SaveDialogOptions, SaveDialogReturnValue } from "electron";
import type { DesktopVietnamMapExportKind, DesktopVietnamMapExportResult } from "@lxe/desktop-protocol";

/** Only the native dialog can choose the destination; the renderer supplies a kind. */
export async function exportVietnamMapWithDialog(
  kind: unknown,
  showSaveDialog: (options: SaveDialogOptions) => Promise<SaveDialogReturnValue>,
  write: (kind: DesktopVietnamMapExportKind, path: string) => Promise<DesktopVietnamMapExportResult>,
): Promise<DesktopVietnamMapExportResult | null> {
  if (kind !== "template" && kind !== "current") throw new Error("Invalid Vietnam SKU map export kind");
  const selection = await showSaveDialog({
    defaultPath: kind === "template" ? "vietnam-sku-map-template.xlsx" : "vietnam-sku-map.xlsx",
    filters: [{ name: "Excel", extensions: ["xlsx"] }],
    properties: ["createDirectory", "showOverwriteConfirmation"],
  });
  if (selection.canceled || !selection.filePath) return null;
  return write(kind, selection.filePath);
}
