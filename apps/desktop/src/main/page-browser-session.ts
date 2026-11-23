/** Isolated ordinary browser window for capturing a response during navigation. */
import { randomUUID } from "node:crypto";
import { BrowserWindow, session } from "electron";
import { browserDiagnostic } from "./browser-diagnostics";
import { browserTimeoutMs, browserUrl, navigateBrowserPage } from "./browser-navigation";
import { armBrowserResponse } from "./browser-response";
import type { BrowserSession } from "./browser-session-host";

export class ElectronPageBrowserSession implements BrowserSession {
  private readonly profile = session.fromPartition(`lxe-browser-${randomUUID()}`, { cache: false });
  private readonly window: BrowserWindow;
  private closed = false;

  constructor(readonly ownerSessionId: string, headless = false) {
    this.profile.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    this.profile.setPermissionCheckHandler(() => false);
    this.profile.on("will-download", event => event.preventDefault());
    this.window = new BrowserWindow({
      show: !headless,
      width: 1440,
      height: 1000,
      webPreferences: {
        session: this.profile, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
      },
    });
    this.window.setMenuBarVisibility(false);
    const contents = this.window.webContents;
    const guard = (event: Electron.Event, url: string): void => {
      try { browserUrl(url); } catch { event.preventDefault(); }
    };
    contents.on("will-navigate", guard);
    contents.on("will-redirect", guard);
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
  }

  get currentUrl(): string {
    return this.window.isDestroyed() ? "" : this.window.webContents.getURL();
  }

  diagnostic(error: unknown) {
    return browserDiagnostic(error);
  }

  async invoke(operation: string, args: Record<string, unknown>): Promise<unknown> {
    if (operation !== "navigate_capture") throw new Error(`Unsupported browser operation: ${operation}`);
    if (this.window.isDestroyed()) throw new Error("Temporary browser window is closed");
    const url = browserUrl(String(args.url));
    const expected = browserUrl(String(args.response_url)).split("?")[0];
    const method = String(args.method ?? "POST").toUpperCase();
    const timeout = browserTimeoutMs(args.timeout ?? 30000);
    const contents = this.window.webContents;
    const capture = await armBrowserResponse(contents, timeout,
      (candidate, actualMethod) => candidate.href.split("?")[0] === expected && actualMethod === method,
      error => this.diagnostic(error));
    try {
      await navigateBrowserPage(contents, url, timeout);
      return await capture.response;
    } finally {
      capture.cancel();
      if (capture.ownsDebugger && !contents.isDestroyed() && contents.debugger.isAttached()) {
        contents.debugger.detach();
      }
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    if (!this.window.isDestroyed()) this.window.destroy();
    await this.profile.closeAllConnections();
    await this.profile.clearStorageData();
    await this.profile.clearCache();
    this.closed = true;
  }
}
