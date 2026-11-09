import { BrowserWindow, WebContentsView, session, Menu, type Session } from "electron";
import { randomUUID } from "node:crypto";
import type { BrowserSnapshot, ManualToolEvent } from "@lxe/desktop-protocol";
interface Browser { view: WebContentsView; snapshot: BrowserSnapshot }
export function browserUrl(raw: string): string {
  const value = raw.trim();
  const url = new URL(/^[a-z][a-z\d+.-]*:/i.test(value) ? value : `https://${value}`);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Browser URLs must use HTTP or HTTPS without embedded credentials");
  return url.href;
}
export class ManualBrowsers {
  private readonly items = new Map<string, Browser>();
  private readonly partitions = new Map<string, Session>();
  constructor(private readonly window: () => BrowserWindow | undefined, private readonly emit: (event: ManualToolEvent) => void) {}
  private partition(directory: string): Session {
    let profile = this.partitions.get(directory);
    if (!profile) {
      profile = session.fromPartition(`lxe-manual-${randomUUID()}`);
      profile.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      profile.setPermissionCheckHandler(() => false);
      profile.setDevicePermissionHandler(() => false);
      profile.setDisplayMediaRequestHandler((_request, callback) => callback({}));
      profile.on("will-download", (event, _item, contents) => {
        event.preventDefault();
        const entry = [...this.items.values()].find(item => item.view.webContents === contents);
        if (entry) { entry.snapshot.error = "Downloads are disabled in this browser"; this.publish(entry); }
      });
      this.partitions.set(directory, profile);
    }
    return profile;
  }
  private owned(sessionId: string, id: string): Browser | undefined {
    const entry = this.items.get(id); if (entry && entry.snapshot.sessionId !== sessionId) throw new Error("Browser belongs to another session"); return entry;
  }
  get(sessionId: string, id: string): BrowserSnapshot | null { const entry = this.owned(sessionId, id); return entry ? { ...entry.snapshot } : null; }
  private publish(entry: Browser): void {
    const wc = entry.view.webContents;
    if (!wc.isDestroyed()) Object.assign(entry.snapshot, { url: wc.getURL() === "about:blank" ? "" : wc.getURL(), title: wc.getTitle(), loading: wc.isLoading(), canGoBack: wc.navigationHistory.getActiveIndex() > 0, canGoForward: wc.navigationHistory.getActiveIndex() + 1 < wc.navigationHistory.length() });
    this.emit({ kind: "browser.state", snapshot: { ...entry.snapshot } });
  }
  create(sessionId: string, id: string, directory: string, initial?: string): BrowserSnapshot {
    const old = this.get(sessionId, id); if (old) return old;
    const window = this.window(); if (!window || window.isDestroyed()) throw new Error("Desktop window is unavailable");
    const view = new WebContentsView({ webPreferences: { session: this.partition(directory), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, spellcheck: false } });
    const entry: Browser = { view, snapshot: { id, sessionId, url: "", title: "", loading: false, canGoBack: false, canGoForward: false, error: "" } };
    this.items.set(id, entry); window.contentView.addChildView(view); view.setVisible(false);
    const wc = view.webContents;
    const guard = (event: { preventDefault(): void }, url: string) => { try { this.validate(url); } catch (error) { event.preventDefault(); entry.snapshot.error = String(error); this.publish(entry); } };
    wc.on("will-navigate", guard); wc.on("will-redirect", guard);
    wc.setWindowOpenHandler(({ url }) => { try { this.emit({ kind: "browser.open", sessionId, url: this.validate(url) }); } catch (error) { entry.snapshot.error = String(error); this.publish(entry); } return { action: "deny" }; });
    wc.on("did-start-loading", () => this.publish(entry));
    wc.on("did-stop-loading", () => this.publish(entry));
    wc.on("did-navigate", () => this.publish(entry));
    wc.on("did-navigate-in-page", () => this.publish(entry));
    wc.on("page-title-updated", () => this.publish(entry));
    wc.on("did-fail-load", (_event, code, description, url, main) => { if (main && code !== -3) { entry.snapshot.error = `${description} (${code}): ${url}`; this.publish(entry); } });
    wc.on("render-process-gone", (_event, details) => { entry.snapshot.error = `${details.reason} (exit ${details.exitCode})`; this.publish(entry); });
    wc.on("context-menu", (_event, params) => { Menu.buildFromTemplate(params.isEditable ? [{ role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] : [{ role: "copy", enabled: Boolean(params.selectionText) }, { role: "selectAll" }]).popup({ window }); });
    if (initial) this.navigate(sessionId, id, initial);
    return { ...entry.snapshot };
  }
  private validate(raw: string): string {
    const url = browserUrl(raw), renderer = this.window()?.webContents.getURL();
    if (renderer && new URL(url).origin === new URL(renderer).origin) throw new Error("The application renderer cannot be opened in the browser panel");
    return url;
  }
  navigate(sessionId: string, id: string, raw: string): void {
    const entry = this.owned(sessionId, id); if (!entry) throw new Error("Browser tab not found");
    const url = this.validate(raw); entry.snapshot.error = "";
    void entry.view.webContents.loadURL(url).catch(error => { if (!entry.view.webContents.isDestroyed()) { entry.snapshot.error = String(error); this.publish(entry); } });
  }
  command(sessionId: string, id: string, command: "back" | "forward" | "reload"): void {
    const entry = this.owned(sessionId, id); if (!entry) throw new Error("Browser tab not found");
    const wc = entry.view.webContents; entry.snapshot.error = "";
    if (command === "reload") wc.reload();
    else {
      const index = wc.navigationHistory.getActiveIndex() + (command === "back" ? -1 : 1);
      if (index >= 0 && index < wc.navigationHistory.length()) wc.navigationHistory.goToIndex(index);
    }
  }
  present(sessionId: string, id: string, bounds: { x: number; y: number; width: number; height: number } | null): void {
    const entry = this.owned(sessionId, id); if (!entry) return;
    if (!bounds) { entry.view.setVisible(false); return; }
    this.hide();
    const window = this.window(); if (!window || !window.isVisible()) return;
    const zoom = window.webContents.getZoomFactor(), [width = 0, height = 0] = window.getContentSize();
    const x = Math.max(0, Math.round(bounds.x * zoom)), y = Math.max(0, Math.round(bounds.y * zoom));
    entry.view.setBounds({ x, y, width: Math.max(0, Math.min(width - x, Math.round(bounds.width * zoom))), height: Math.max(0, Math.min(height - y, Math.round(bounds.height * zoom))) });
    entry.view.setVisible(bounds.width > 0 && bounds.height > 0);
  }
  hide(): void { for (const entry of this.items.values()) entry.view.setVisible(false); }
  close(sessionId: string, id: string): void {
    const entry = this.owned(sessionId, id); if (!entry) return;
    const window = this.window();
    if (window && !window.isDestroyed()) window.contentView.removeChildView(entry.view);
    if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close({ waitForBeforeUnload: false });
    this.items.delete(id);
  }
  closeSession(sessionId?: string): void { for (const entry of this.items.values()) if (!sessionId || entry.snapshot.sessionId === sessionId) this.close(entry.snapshot.sessionId, entry.snapshot.id); }
}
