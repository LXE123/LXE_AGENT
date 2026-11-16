import { randomUUID } from "node:crypto";
import { app, session, shell, type DownloadItem, type NavigationEntry, type WebContents } from "electron";
import { createLogger } from "@lxe/core";
import { TEAM_SKILLS_URL, type TeamSkillsBrowserState } from "@lxe/desktop-protocol/team-skills";
import { IPC_CHANNELS } from "../ipc-channels";
import { WindowTabBudget } from "./manual-tools/tab-budget";
import type { ManualBrowsers } from "./manual-tools/browsers";

const logger = createLogger("desktop.team-skills");
const partition = "persist:lxe-workbench-team-skills";

export function registerTeamSkillsGuest(dashboard: WebContents, browsers?: ManualBrowsers): void {
  // will-attach-webview does not identify the requesting frame. Only the dashboard's
  // main frame can obtain this single-use initial src. Replace it before navigation.
  const budget = browsers?.watchWindow(dashboard) ?? new WindowTabBudget();
  const attaching = new WeakMap<WebContents, string>();
  const downloads = new Set<DownloadItem>();
  let mountSrc: string | undefined;
  let pendingSrc: string | undefined;
  let contents: WebContents | undefined;
  let history: { entries: NavigationEntry[]; index: number } | undefined;
  let restoring = false;

  function targetUrl(raw: string): URL | undefined {
    const target = URL.parse(raw);
    if (target?.protocol !== "https:" || target.username || target.password || target.origin === URL.parse(dashboard.getURL())?.origin) return;
    return target;
  }

  function release(): void {
    const guest = contents;
    contents = undefined;
    pendingSrc = undefined;
    mountSrc = undefined;
    restoring = false;
    if (guest && !guest.isDestroyed()) guest.close({ waitForBeforeUnload: false });
  }

  const page = budget.track("team-skills", {
    isLive: () => !!contents && !contents.isDestroyed(),
    isBusy: () => restoring || downloads.size > 0 || !!contents?.isLoading() || !!contents?.isCurrentlyAudible(),
    suspend: () => {
      const nav = contents?.navigationHistory;
      if (nav && nav.length() > 0) history = { entries: nav.getAllEntries(), index: nav.getActiveIndex() };
      release();
    },
  });

  dashboard.ipc.handle(IPC_CHANNELS.teamSkillsView, (event, action: unknown) => {
    if (event.senderFrame !== dashboard.mainFrame) throw new Error("Team skills requires the desktop main frame");
    if (action === "hide") {
      page.setVisible(false);
      return null;
    }
    if (action !== "show" && action !== "retry") throw new Error("Unknown team skills view action");
    page.setVisible(true);
    if (action === "retry") {
      history = undefined;
      release();
    }
    if (!mountSrc) pendingSrc = mountSrc = `about:blank#${randomUUID()}`;
    return mountSrc;
  });
  dashboard.ipc.handle(IPC_CHANNELS.teamSkillsBrowser, async (event, ticket: unknown, command: unknown): Promise<TeamSkillsBrowserState | null> => {
    if (event.senderFrame !== dashboard.mainFrame) throw new Error("Team skills requires the desktop main frame");
    const guest = contents;
    if (!guest || guest.isDestroyed() || ticket !== mountSrc) return null;
    const nav = guest.navigationHistory;
    if (command !== "state") {
      if (!page.visible) return null;
      if (command === "back") { if (nav.canGoBack()) nav.goBack(); }
      else if (command === "forward") { if (nav.canGoForward()) nav.goForward(); }
      else if (command === "reload") guest.reload();
      else if (command && typeof command === "object" && "url" in command && typeof command.url === "string") {
        const address = command.url.trim();
        const hasScheme = /^[a-z][a-z\d+.-]*:/i.test(address) && !/^[\w.-]+:\d+(?:[/?#]|$)/.test(address);
        const target = targetUrl(hasScheme ? address : `https://${address}`);
        if (!target) throw new Error("Enter an HTTPS website address without embedded credentials.");
        try { await guest.loadURL(target.href); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ERR_ABORTED") throw error;
        }
      } else throw new Error("Unknown team skills browser command");
    }
    if (contents !== guest || guest.isDestroyed()) return null;
    const url = guest.getURL();
    return { url: url.startsWith("https://") ? url : "", canGoBack: nav.canGoBack(), canGoForward: nav.canGoForward() };
  });
  dashboard.on("did-start-navigation", event => {
    if (event.isMainFrame && !event.isSameDocument) {
      release();
      history = undefined;
      page.setVisible(false);
    }
  });

  const profile = session.fromPartition(partition);
  profile.setPermissionCheckHandler(() => false);
  profile.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  profile.setDevicePermissionHandler(() => false);
  profile.setDisplayMediaRequestHandler((_request, callback) => callback({}));

  const onDownload = (_event: Electron.Event, item: DownloadItem, source: WebContents) => {
    if (source !== contents) return;
    downloads.add(item);
    item.once("done", () => { downloads.delete(item); budget.enforce(); });
  };
  profile.on("will-download", onDownload);
  dashboard.once("destroyed", () => {
    profile.off("will-download", onDownload);
    release();
    page.remove();
  });

  dashboard.on("will-attach-webview", (event, preferences, params) => {
    if (params.webpreferences || params.preload || params.partition || params.httpreferrer || params.useragent
      || params.blinkfeatures || params.disableblinkfeatures || params.plugins
      || params.nodeintegration || params.nodeintegrationinsubframes || params.disablewebsecurity) {
      event.preventDefault();
      return;
    }
    if (pendingSrc && params.src === pendingSrc) {
      const ticket = pendingSrc;
      pendingSrc = undefined;
      const created = (_event: Electron.Event, guest: WebContents) => {
        if (guest.getType() === "webview" && guest.session === profile) attaching.set(guest, ticket);
      };
      app.once("web-contents-created", created);
      queueMicrotask(() => app.off("web-contents-created", created));
      params.src = history ? "" : TEAM_SKILLS_URL;
      preferences.partition = partition;
    } else if (!browsers?.prepareGuest(dashboard, preferences, params)) {
      event.preventDefault();
      return;
    }
    preferences.sandbox = true;
    preferences.contextIsolation = true;
    preferences.nodeIntegration = false;
    preferences.webSecurity = true;
    preferences.webviewTag = false;
  });

  dashboard.on("did-attach-webview", (_event, guest) => {
    if (browsers?.attachGuest(dashboard, guest)) return;
    if (!mountSrc || attaching.get(guest) !== mountSrc) { guest.close(); return; }
    contents = guest;
    guest.once("destroyed", () => {
      if (contents !== guest) return;
      contents = undefined;
      mountSrc = undefined;
      restoring = false;
      budget.enforce();
    });
    guest.on("did-stop-loading", () => budget.enforce());
    guest.on("audio-state-changed", () => budget.enforce());
    guest.on("will-navigate", event => {
      if (!targetUrl(event.url)) event.preventDefault();
    });
    guest.on("will-redirect", event => {
      if (event.isMainFrame && !targetUrl(event.url)) event.preventDefault();
    });
    guest.setWindowOpenHandler(({ url, postBody }) => {
      // The system browser can open a URL, but cannot receive a popup's POST body.
      const target = targetUrl(url);
      if (target && postBody === undefined) {
        void shell.openExternal(target.href).catch(error => logger.warn("catalog_external_open_failed", { error }));
      }
      return { action: "deny" };
    });
    const saved = history;
    if (saved) {
      restoring = true;
      void guest.navigationHistory.restore(saved).catch(error => {
        if (contents !== guest) return;
        logger.warn("catalog_history_restore_failed", { error });
        return guest.loadURL(TEAM_SKILLS_URL);
      }).catch(error => {
        if (contents === guest) logger.warn("catalog_fallback_load_failed", { error });
      }).finally(() => {
        if (contents !== guest) return;
        history = undefined;
        restoring = false;
        budget.enforce();
      });
    }
    budget.enforce();
  });
}
