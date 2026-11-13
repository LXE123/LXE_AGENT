import { randomUUID } from "node:crypto";
import { ipcMain, session, type WebContents } from "electron";
import { TEAM_SKILLS_URL } from "@lxe/desktop-protocol/team-skills";
import { IPC_CHANNELS } from "../ipc-channels";
import { browserNavigationError, browserUrl } from "./browser-navigation";

const partition = "persist:lxe-workbench-team-skills";

export function registerTeamSkillsGuest(dashboard: WebContents): void {
  // will-attach-webview does not identify the requesting frame. Only the dashboard's
  // main frame can obtain this single-use initial src. Replace it before navigation.
  let pendingSrc: string | undefined;
  ipcMain.handle(IPC_CHANNELS.prepareTeamSkillsView, event => {
    if (event.sender !== dashboard || event.senderFrame !== dashboard.mainFrame) {
      throw new Error("Team skills requires the desktop main frame");
    }
    pendingSrc = `about:blank#${randomUUID()}`;
    return pendingSrc;
  });
  dashboard.on("did-start-navigation", event => {
    if (event.isMainFrame && !event.isSameDocument) pendingSrc = undefined;
  });
  dashboard.once("destroyed", () => ipcMain.removeHandler(IPC_CHANNELS.prepareTeamSkillsView));

  const profile = session.fromPartition(partition);
  profile.setPermissionCheckHandler(() => false);
  profile.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  profile.setDevicePermissionHandler(() => false);
  profile.setDisplayMediaRequestHandler((_request, callback) => callback({}));

  dashboard.on("will-attach-webview", (event, preferences, params) => {
    if (!pendingSrc || params.src !== pendingSrc || params.webpreferences || params.preload
      || params.partition || params.httpreferrer || params.useragent
      || params.blinkfeatures || params.disableblinkfeatures || params.plugins
      || params.nodeintegration || params.nodeintegrationinsubframes || params.disablewebsecurity) {
      event.preventDefault();
      return;
    }
    pendingSrc = undefined;
    params.src = TEAM_SKILLS_URL;
    preferences.partition = partition;
    preferences.sandbox = true;
    preferences.contextIsolation = true;
    preferences.nodeIntegration = false;
    preferences.webSecurity = true;
    preferences.webviewTag = false;
  });

  dashboard.on("did-attach-webview", (_event, guest) => {
    const publishError = (message: string) => {
      if (!dashboard.isDestroyed() && !guest.isDestroyed()) dashboard.send(IPC_CHANNELS.teamSkillsNavigationError, message);
    };
    const validate = (url: string): string | undefined => {
      try { return browserUrl(url, dashboard.getURL()); }
      catch (error) { publishError(browserNavigationError(error)); return undefined; }
    };
    guest.on("will-navigate", event => {
      if (!validate(event.url)) event.preventDefault();
    });
    guest.on("will-redirect", event => {
      if (event.isMainFrame && !validate(event.url)) event.preventDefault();
    });
    guest.on("did-navigate", () => publishError(""));
    guest.setWindowOpenHandler(({ url }) => {
      const target = validate(url);
      // The catalog has one view: follow web links there, keeping its login session.
      // Do not let remote pages create native windows or invoke OS URL handlers.
      if (target) setImmediate(() => {
        if (!guest.isDestroyed()) void guest.loadURL(target).catch(error => publishError(browserNavigationError(error)));
      });
      return { action: "deny" };
    });
  });
}
