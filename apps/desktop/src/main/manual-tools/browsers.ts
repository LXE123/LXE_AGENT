import { app, BrowserWindow, Menu, session, type NavigationEntry, type Session, type WebContents, type WebPreferences } from "electron";
import { randomUUID } from "node:crypto";
import type { BrowserMount, BrowserSnapshot, ManualToolEvent } from "@lxe/desktop-protocol";
import { planTabSuspension } from "./tab-budget";

interface Browser {
  owner: WebContents;
  profile: Session;
  partition: string;
  snapshot: BrowserSnapshot;
  mountSrc?: string;
  contents?: WebContents;
  history?: { entries: NavigationEntry[]; index: number };
  attaching: boolean;
  restoring: boolean;
  visible: boolean;
  lastUsed: number;
}
interface WindowBudget {
  selected: Map<string, { id: string; at: number }>;
  activeSession?: string;
  timer?: ReturnType<typeof setTimeout>;
}

export function browserUrl(raw: string): string {
  const value = raw.trim();
  const url = new URL(/^[a-z][a-z\d+.-]*:/i.test(value) ? value : `https://${value}`);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Browser URLs must use HTTP or HTTPS without embedded credentials");
  return url.href;
}

export class ManualBrowsers {
  private readonly items = new Map<string, Browser>();
  private readonly profiles = new Map<string, { partition: string; profile: Session }>();
  private readonly windows = new Map<WebContents, WindowBudget>();
  private readonly attachingGuests = new WeakMap<WebContents, { tab: Browser; mountSrc: string }>();
  private sequence = 0;
  constructor(private readonly window: () => BrowserWindow | undefined, private readonly emit: (event: ManualToolEvent) => void) {}

  private profile(directory: string) {
    const existing = this.profiles.get(directory);
    if (existing) return existing;
    const partition = `lxe-manual-${randomUUID()}`;
    const profile = session.fromPartition(partition);
    profile.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    profile.setPermissionCheckHandler(() => false);
    profile.setDevicePermissionHandler(() => false);
    profile.setDisplayMediaRequestHandler((_request, callback) => callback({}));
    profile.on("will-download", (event, _item, contents) => {
      event.preventDefault();
      const entry = [...this.items.values()].find(item => item.contents === contents);
      if (entry) { entry.snapshot.error = "Downloads are disabled in this browser"; this.publish(entry); }
    });
    const result = { partition, profile };
    this.profiles.set(directory, result);
    return result;
  }

  private owned(sessionId: string, id: string) {
    const tab = this.items.get(id);
    if (tab && tab.snapshot.sessionId !== sessionId) throw new Error("Browser belongs to another session");
    return tab;
  }

  private validate(raw: string): string {
    const url = browserUrl(raw), renderer = this.window()?.webContents.getURL();
    if (renderer && new URL(url).origin === new URL(renderer).origin) throw new Error("The application renderer cannot be opened in the browser panel");
    return url;
  }

  get(sessionId: string, id: string): BrowserSnapshot | null {
    const tab = this.owned(sessionId, id);
    return tab ? { ...tab.snapshot } : null;
  }

  create(sessionId: string, id: string, directory: string, initial?: string): BrowserMount {
    const owner = this.window()?.webContents;
    if (!owner || owner.isDestroyed()) throw new Error("Desktop window is unavailable");
    let tab = this.owned(sessionId, id);
    if (!tab) {
      const url = initial ? this.validate(initial) : "";
      tab = { owner, ...this.profile(directory), attaching: false, restoring: false, visible: false, lastUsed: 0,
        snapshot: { id, sessionId, url, title: "", loading: false, canGoBack: false, canGoForward: false, error: "" } };
      this.items.set(id, tab);
    }
    if (tab.owner !== owner) throw new Error("Browser belongs to another window");
    tab.mountSrc ??= `about:blank#lxe-browser-${randomUUID()}`;
    return { ...tab.snapshot, mountSrc: tab.mountSrc };
  }

  // Only a main-frame IPC caller can obtain a single-use mount URL. The main
  // process chooses the workspace session and enforces the guest preferences.
  prepareGuest(owner: WebContents, preferences: WebPreferences, params: Record<string, string>): boolean {
    const mountSrc = params.src;
    if (!mountSrc) return false;
    const tab = [...this.items.values()].find(item => item.owner === owner && item.mountSrc === mountSrc);
    if (!tab || tab.attaching || tab.contents) return false;
    tab.attaching = true;
    preferences.partition = tab.partition;
    // Electron creates the guest synchronously after will-attach-webview. Bind
    // that specific WebContents before asynchronous attaches can finish out of order.
    const created = (_event: Electron.Event, guest: WebContents) => {
      if (guest.getType() === "webview" && guest.session === tab.profile) {
        this.attachingGuests.set(guest, { tab, mountSrc });
      }
    };
    app.once("web-contents-created", created);
    queueMicrotask(() => app.off("web-contents-created", created));
    // A restored guest must have pristine history. Never navigate to the ticket.
    params.src = "";
    return true;
  }

  attachGuest(owner: WebContents, guest: WebContents): boolean {
    const mount = this.attachingGuests.get(guest);
    if (!mount && ![...this.profiles.values()].some(item => item.profile === guest.session)) return false;
    this.attachingGuests.delete(guest);
    if (!mount || mount.tab.owner !== owner || mount.tab.mountSrc !== mount.mountSrc) {
      guest.close();
      return true;
    }
    const tab = mount.tab;
    tab.attaching = false;
    tab.contents = guest;
    this.bind(tab, guest);
    return true;
  }

  private bind(tab: Browser, wc: WebContents): void {
    const { id, sessionId } = tab.snapshot;
    const fail = (cause: unknown) => {
      if (tab.contents !== wc) return;
      tab.snapshot.error = String(cause); this.publish(tab);
    };
    const guard = (event: { preventDefault(): void; url: string }) => { try { this.validate(event.url); } catch (error) { event.preventDefault(); fail(error); } };
    wc.on("will-navigate", guard);
    wc.on("will-redirect", guard);
    wc.setWindowOpenHandler(({ url, postBody }) => {
      // A URL-only sidebar tab cannot carry the original form data.
      if (postBody !== undefined) return { action: "deny" };
      try { this.emit({ kind: "browser.open", sessionId, url: this.validate(url) }); } catch (error) { fail(error); }
      return { action: "deny" };
    });
    wc.on("before-input-event", (event, input) => {
      const refreshModifier = process.platform === "darwin" ? input.meta && !input.control : input.control && !input.meta;
      if (input.type !== "keyDown" || input.key.toLowerCase() !== "r" || !refreshModifier || input.alt || input.shift) return;
      if (tab.contents !== wc || !tab.visible) return;
      event.preventDefault();
      if (!input.isAutoRepeat) this.command(sessionId, id, "reload");
    });
    wc.on("context-menu", (_event, params) => {
      const window = this.window();
      if (!window || window.isDestroyed()) return;
      Menu.buildFromTemplate(params.isEditable ? [{ role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] : [{ role: "copy", enabled: Boolean(params.selectionText) }, { role: "selectAll" }]).popup({ window });
    });
    const update = () => { if (tab.contents === wc) this.publish(tab); };
    wc.on("did-start-loading", update);
    wc.on("page-title-updated", update);
    wc.on("did-navigate", update);
    wc.on("did-navigate-in-page", update);
    wc.on("did-stop-loading", () => { update(); this.enforce(tab.owner); });
    wc.on("audio-state-changed", () => this.enforce(tab.owner));
    wc.on("did-fail-load", (_event, code, description, url, main) => { if (main && code !== -3) fail(`${description} (${code}): ${url}`); });
    wc.on("render-process-gone", (_event, details) => fail(`${details.reason} (exit ${details.exitCode})`));
    wc.once("destroyed", () => {
      if (tab.contents !== wc) return;
      delete tab.contents; delete tab.mountSrc; tab.attaching = false;
    });
    const history = tab.history;
    if (history) {
      tab.restoring = true;
      void wc.navigationHistory.restore(history).then(() => {
        if (tab.contents === wc && tab.history === history) delete tab.history;
      }).catch(fail).finally(() => {
        if (tab.contents !== wc) return;
        tab.restoring = false; update(); this.enforce(tab.owner);
      });
    } else if (tab.snapshot.url) {
      this.navigate(sessionId, id, tab.snapshot.url);
    }
    update();
    this.enforce(tab.owner);
  }

  private publish(tab: Browser): void {
    const wc = tab.contents;
    if (wc && !wc.isDestroyed()) {
      const url = wc.getURL();
      if (url && !url.startsWith("about:blank")) {
        const index = wc.navigationHistory.getActiveIndex();
        Object.assign(tab.snapshot, { url, title: wc.getTitle(), canGoBack: index > 0, canGoForward: index + 1 < wc.navigationHistory.length() });
      }
      tab.snapshot.loading = wc.isLoading();
    }
    this.emit({ kind: "browser.state", snapshot: { ...tab.snapshot } });
  }

  navigate(sessionId: string, id: string, raw: string): void {
    const tab = this.owned(sessionId, id);
    if (!tab) throw new Error("Browser tab not found");
    const url = this.validate(raw);
    tab.snapshot.url = url; tab.snapshot.error = "";
    const wc = tab.contents;
    if (wc) {
      void wc.loadURL(url).catch(error => {
        if (tab.contents === wc && !wc.isDestroyed()) { tab.snapshot.error = String(error); this.publish(tab); }
      });
    } else delete tab.history;
  }

  command(sessionId: string, id: string, command: "back" | "forward" | "reload"): void {
    const tab = this.owned(sessionId, id);
    if (!tab) throw new Error("Browser tab not found");
    const wc = tab.contents;
    if (!wc || wc.isDestroyed()) return;
    tab.snapshot.error = "";
    if (command === "reload") { wc.reload(); return; }
    const history = wc.navigationHistory;
    const index = history.getActiveIndex() + (command === "back" ? -1 : 1);
    if (index >= 0 && index < history.length()) history.goToIndex(index);
  }

  visible(sessionId: string, id: string, mountSrc: string, visible: boolean): boolean {
    const tab = this.owned(sessionId, id);
    if (!tab || tab.mountSrc !== mountSrc) return false;
    if (tab.visible === visible) return true;
    tab.visible = visible;
    let budget = this.windows.get(tab.owner);
    if (!budget) { budget = { selected: new Map() }; this.windows.set(tab.owner, budget); }
    if (visible) {
      tab.lastUsed = ++this.sequence;
      budget.activeSession = sessionId;
      budget.selected.set(sessionId, { id, at: Date.now() });
    } else if (budget.selected.get(sessionId)?.id === id) {
      budget.selected.set(sessionId, { id, at: Date.now() });
    }
    this.enforce(tab.owner);
    return true;
  }

  private enforce(owner: WebContents): void {
    const budget = this.windows.get(owner);
    if (!budget) return;
    clearTimeout(budget.timer);
    const live = [...this.items.values()].filter(tab => tab.owner === owner && tab.contents && !tab.contents.isDestroyed());
    const { victims, retryAt } = planTabSuspension(live.map(tab => ({
      id: tab.snapshot.id, sessionId: tab.snapshot.sessionId, visible: tab.visible, lastUsed: tab.lastUsed,
      busy: tab.restoring || tab.contents!.isLoading() || tab.contents!.isCurrentlyAudible(),
    })), budget.selected, budget.activeSession, Date.now());
    for (const id of victims) this.suspend(this.items.get(id)!);
    if (retryAt !== undefined) {
      budget.timer = setTimeout(() => this.enforce(owner), Math.max(1, retryAt - Date.now()));
      budget.timer.unref();
    }
  }

  private suspend(tab: Browser): void {
    const wc = tab.contents;
    const history = wc && !wc.isDestroyed() ? wc.navigationHistory : undefined;
    if (!tab.restoring && history && history.length() > 0) {
      tab.history = { entries: history.getAllEntries(), index: history.getActiveIndex() };
    }
    tab.visible = false;
    this.release(tab);
  }

  watchWindow(owner: WebContents): void {
    owner.on("did-start-navigation", event => {
      if (!event.isMainFrame || event.isSameDocument) return;
      for (const tab of this.items.values()) {
        if (tab.owner === owner && tab.mountSrc) this.suspend(tab);
      }
    });
    owner.once("destroyed", () => {
      for (const tab of this.items.values()) {
        if (tab.owner === owner) this.close(tab.snapshot.sessionId, tab.snapshot.id);
      }
    });
  }

  private release(tab: Browser): void {
    const mountSrc = tab.mountSrc, contents = tab.contents;
    delete tab.contents; delete tab.mountSrc; tab.attaching = false; tab.restoring = false;
    if (contents && !contents.isDestroyed()) contents.close({ waitForBeforeUnload: false });
    if (mountSrc) this.emit({ kind: "browser.release", sessionId: tab.snapshot.sessionId, id: tab.snapshot.id, mountSrc });
  }

  close(sessionId: string, id: string): void {
    const tab = this.owned(sessionId, id);
    if (!tab) return;
    this.release(tab);
    this.items.delete(id);
    const budget = this.windows.get(tab.owner);
    if (budget?.selected.get(sessionId)?.id === id) budget.selected.delete(sessionId);
    if (![...this.items.values()].some(item => item.owner === tab.owner)) {
      clearTimeout(budget?.timer); this.windows.delete(tab.owner);
    } else this.enforce(tab.owner);
  }
  closeSession(sessionId?: string): void {
    for (const tab of this.items.values()) if (!sessionId || tab.snapshot.sessionId === sessionId) this.close(tab.snapshot.sessionId, tab.snapshot.id);
  }
}
