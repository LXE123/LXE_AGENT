import type { DesktopTitlebarAction, DesktopTitlebarMenuRequest } from "@lxe/desktop-protocol";
import type { KeyboardInputEvent, MenuItemConstructorOptions } from "electron";

export function validateTitlebarMenu(value: unknown): DesktopTitlebarMenuRequest {
  const input = value as Partial<DesktopTitlebarMenuRequest> | null;
  if (!input || !["application", "edit"].includes(input.menu ?? "")
    || !["zh", "en"].includes(input.language ?? "")
    || typeof input.x !== "number" || typeof input.y !== "number"
    || !Number.isFinite(input.x) || !Number.isFinite(input.y)
    || input.x < 0 || input.y < 0 || input.x > 100_000 || input.y > 100_000) {
    throw new Error("Invalid desktop titlebar menu request");
  }
  return input as DesktopTitlebarMenuRequest;
}

/** Native keyboard input also reaches editor-owned history (including Lexical). */
export function sendEditingShortcut(send: (event: KeyboardInputEvent) => void, keyCode: string): void {
  send({ type: "keyDown", keyCode, modifiers: ["control"] });
  send({ type: "keyUp", keyCode, modifiers: ["control"] });
}

export function titlebarMenuTemplate(
  request: DesktopTitlebarMenuRequest,
  actions: { select(action: DesktopTitlebarAction): void; edit(key: string): void; quit(): void; canCheckUpdates: boolean },
): MenuItemConstructorOptions[] {
  const zh = request.language === "zh";
  if (request.menu === "application") return [
    { label: zh ? "设置" : "Settings", click: () => actions.select("settings") },
    { label: zh ? "检查更新" : "Check for updates", enabled: actions.canCheckUpdates, click: () => actions.select("check-updates") },
    { type: "separator" },
    { label: zh ? "退出" : "Quit", click: actions.quit },
  ];
  const edit = (label: string, key: string): MenuItemConstructorOptions => ({
    label, accelerator: `Ctrl+${key}`, registerAccelerator: false, click: () => actions.edit(key),
  });
  return [
    edit(zh ? "撤销" : "Undo", "Z"), edit(zh ? "重做" : "Redo", "Y"),
    { type: "separator" },
    edit(zh ? "剪切" : "Cut", "X"), edit(zh ? "复制" : "Copy", "C"), edit(zh ? "粘贴" : "Paste", "V"),
    { type: "separator" }, edit(zh ? "全选" : "Select all", "A"),
  ];
}
