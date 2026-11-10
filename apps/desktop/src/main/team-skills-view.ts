import { randomUUID } from "node:crypto";
import { ipcMain, session, shell, type WebContents } from "electron";
import { TEAM_SKILLS_URL } from "@lxe/desktop-protocol/team-skills";
import { IPC_CHANNELS } from "../ipc-channels";

const catalogOrigin = new URL(TEAM_SKILLS_URL).origin;
const partition = "persist:lxe-workbench-team-skills";

function httpsUrl(raw: string): URL | undefined {
  const url = URL.canParse(raw) ? new URL(raw) : undefined;
  return url?.protocol === "https:" && !url.username && !url.password ? url : undefined;
}

// Feishu redirects between its Accounts, Passport and Miaoda hosts during sign-in.
function isFeishuPage(url: URL | undefined): boolean {
  return !!url && (url.origin === catalogOrigin || (!url.port && url.hostname.endsWith(".feishu.cn")));
}

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
      || params.partition || params.allowpopups || params.httpreferrer || params.useragent
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
    guest.on("will-navigate", event => {
      if (!isFeishuPage(httpsUrl(event.url))) event.preventDefault();
    });
    guest.on("will-redirect", event => {
      if (event.isMainFrame && !isFeishuPage(httpsUrl(event.url))) event.preventDefault();
    });
    guest.setWindowOpenHandler(({ url }) => {
      const target = httpsUrl(url);
      if (target && isFeishuPage(target) && target.origin !== catalogOrigin) {
        void guest.loadURL(target.href).catch(() => {});
      } else if (target && (target.origin === catalogOrigin || target.origin === "https://agentskills.io")) {
        void shell.openExternal(target.href).catch(() => {});
      }
      return { action: "deny" };
    });
  });
}
