import type { BrowserWindow, WebContentsView } from "electron";
import type { NativeViewBounds } from "@lxe/desktop-protocol";

export function presentNativeView(window: BrowserWindow, view: WebContentsView, rect: NativeViewBounds | null): void {
  if (!rect || !window.isVisible()) {
    view.setVisible(false);
    return;
  }
  const zoom = window.webContents.getZoomFactor();
  const [width = 0, height = 0] = window.getContentSize();
  const x = Math.max(0, Math.round(rect.x * zoom)), y = Math.max(0, Math.round(rect.y * zoom));
  const right = Math.min(width, Math.round((rect.x + rect.width) * zoom));
  const bottom = Math.min(height, Math.round((rect.y + rect.height) * zoom));
  view.setBounds({ x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) });
  view.setVisible(right > x && bottom > y);
}
