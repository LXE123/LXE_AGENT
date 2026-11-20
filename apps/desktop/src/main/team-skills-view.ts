import { randomUUID } from "node:crypto";
import { app, session, shell, type DownloadItem, type NavigationEntry, type WebContents } from "electron";
import { createLogger } from "@lxe/core";
import { TEAM_SKILLS_URL, isTeamSkillsPage, validTeamSkillId, validTeamVersion, type TeamUninstallTarget, type TeamUseTarget, type TeamUseRequest, parseTeamInstallTicket, type TeamInstallTicket, type TeamInstallResult, type TeamSkillsBrowserState } from "@lxe/desktop-protocol/team-skills";
import { IPC_CHANNELS } from "../ipc-channels";
import { WindowTabBudget } from "./manual-tools/tab-budget";
import type { ManualBrowsers } from "./manual-tools/browsers";

const logger = createLogger("desktop.team-skills");
const partition = "persist:lxe-workbench-team-skills";

interface CatalogHost {
  preload: string;
  versions(ids: string[]): Promise<Record<string, string>>;
  install(ticket: TeamInstallTicket, replaceLocalName?: string): Promise<TeamInstallResult>;
  uninstallTarget(id: string, version: string): Promise<TeamUninstallTarget>;
  useTarget(id: string): Promise<TeamUseTarget>;
  confirmUninstall(name: string, version: string): Promise<boolean>;
  recycle(target: TeamUninstallTarget): Promise<void>;
  confirmOverwrite(name: string): Promise<boolean>;
}

export function registerTeamSkillsGuest(dashboard: WebContents, browsers?: ManualBrowsers, host?: CatalogHost): void {
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
  const changingSkills = new Set<string>();
  /** Use requests waiting for the dashboard to write the draft, by request ID. */
  const useRequests = new Map<string, (error?: Error) => void>();
  function abandonUseRequests(reason: string): void {
    for (const settle of [...useRequests.values()]) settle(new Error(reason));
  }

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
    isBusy: () => restoring || changingSkills.size > 0 || downloads.size > 0 || !!contents?.isLoading() || !!contents?.isCurrentlyAudible(),
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
  dashboard.ipc.handle(IPC_CHANNELS.teamSkillUseResult, (event, requestId: unknown, error: unknown) => {
    if (event.senderFrame !== dashboard.mainFrame) throw new Error("Team skills requires the desktop main frame");
    if (typeof requestId !== "string" || (error !== undefined && typeof error !== "string")) throw new Error("Invalid team skill use result");
    useRequests.get(requestId)?.(error === undefined ? undefined : new Error(error.slice(0, 2000) || "LXE 未能打开对话"));
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
      abandonUseRequests("LXE 主窗口已重新加载，未写入对话草稿，请重新点击「开始使用」");
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
    abandonUseRequests("LXE 主窗口已关闭，未写入对话草稿");
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
      if (host) preferences.preload = host.preload;
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
    if (host) {
      function catalogActive(event: Electron.IpcMainInvokeEvent): boolean {
        return contents === guest && !guest.isDestroyed() && page.visible && event.senderFrame === guest.mainFrame &&
          isTeamSkillsPage(guest.getURL()) && isTeamSkillsPage(event.senderFrame.url);
      }
      function requireCatalog(event: Electron.IpcMainInvokeEvent) {
        if (!catalogActive(event)) throw new Error("此页面无法访问本机团队技能");
      }
      guest.ipc.handle(IPC_CHANNELS.teamSkillVersions, (event, ids: unknown) => {
        requireCatalog(event);
        if (!Array.isArray(ids) || ids.length > 100 || !ids.every(validTeamSkillId)) throw new Error("无效的技能 ID 列表");
        return host.versions(ids);
      });
      guest.ipc.handle(IPC_CHANNELS.teamSkillUninstall, async (event, id: unknown, installedVersion: unknown) => {
        requireCatalog(event);
        if (!validTeamSkillId(id) || !validTeamVersion(installedVersion)) throw new Error("无效的技能 ID 或本机版本");
        if (changingSkills.has(id)) throw new Error("该技能正在处理，请稍后重试");
        changingSkills.add(id);
        try {
          const target = await host.uninstallTarget(id, installedVersion);
          requireCatalog(event);
          if (!await host.confirmUninstall(target.name, installedVersion)) return false;
          requireCatalog(event);
          await host.recycle(target);
          return true;
        } finally { changingSkills.delete(id); budget.enforce(); }
      });
      guest.ipc.handle(IPC_CHANNELS.teamSkillUse, async (event, id: unknown) => {
        requireCatalog(event);
        if (!validTeamSkillId(id)) throw new Error("无效的技能 ID");
        // The page names only the catalog ID; LXE resolves the local skill and writes the draft.
        const { name }: TeamUseTarget = await host.useTarget(id);
        requireCatalog(event);
        if (dashboard.isDestroyed()) throw new Error("LXE 主窗口已关闭，未写入对话草稿");
        // Resolve only when the dashboard confirms the draft, so the card reports real failures.
        const requestId = randomUUID();
        const written = new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => settle(new Error("30 秒内没有收到 LXE 主窗口的结果，对话草稿可能未写入")), 30_000);
          function settle(error?: Error) {
            clearTimeout(timer);
            useRequests.delete(requestId);
            if (error) reject(error); else resolve();
          }
          useRequests.set(requestId, settle);
        });
        dashboard.send(IPC_CHANNELS.teamSkillUseRequested, { requestId, name } satisfies TeamUseRequest);
        await written;
      });
      const approvals = new Map<string, { token: string; version: string; sha256: string; localName: string }>();
      guest.on("did-start-navigation", event => { if (event.isMainFrame && !event.isSameDocument) approvals.clear(); });
      guest.ipc.handle(IPC_CHANNELS.teamSkillInstall, async (event, raw: unknown, token?: unknown) => {
        requireCatalog(event);
        const ticket = parseTeamInstallTicket(raw);
        if (changingSkills.has(ticket.skillId)) throw new Error("该技能正在处理，请稍后重试");
        changingSkills.add(ticket.skillId);
        try {
          const approved = approvals.get(ticket.skillId);
          approvals.delete(ticket.skillId);
          if (token !== undefined && (!approved || token !== approved.token || approved.version !== ticket.version || approved.sha256 !== ticket.sha256))
            throw new Error("覆盖确认已失效，请重新点击安装");
          const result = await host.install(ticket, token === undefined ? undefined : approved?.localName);
          if (typeof result === "string") return result;
          if (token !== undefined) throw new Error("同名 Skill 已变化，请重新点击安装");
          // Overwriting asks in the catalog window, so the page must still be open; say why nothing was installed.
          const leftCatalog = `本机已有同名 Skill「${result.localName}」，不是从技能库安装的，本次未覆盖。请停留在技能库页面重新点击安装，确认后覆盖`;
          if (!catalogActive(event)) throw new Error(leftCatalog);
          if (!await host.confirmOverwrite(result.localName)) return null;
          if (!catalogActive(event)) throw new Error(leftCatalog);
          const approval = randomUUID();
          approvals.set(ticket.skillId, { token: approval, version: ticket.version, sha256: ticket.sha256, localName: result.localName });
          const timeout = setTimeout(() => { if (approvals.get(ticket.skillId)?.token === approval) approvals.delete(ticket.skillId); }, 120_000);
          timeout.unref();
          return { approval };
        } finally { changingSkills.delete(ticket.skillId); budget.enforce(); }
      });
    }
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
