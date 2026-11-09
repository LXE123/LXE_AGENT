import { session, shell, WebContentsView, type BrowserWindow } from "electron";
import { TEAM_SKILLS_URL, type TeamSkillsViewRequest } from "@lxe/desktop-protocol/team-skills";
import { presentNativeView } from "./native-view-bounds";

const catalogOrigin = new URL(TEAM_SKILLS_URL).origin;
// Feishu redirects between its Accounts, Passport and Miaoda hosts during sign-in.
function isFeishuPage(url: URL | undefined): boolean {
  return !!url && (url.origin === catalogOrigin || (!url.port && url.hostname.endsWith(".feishu.cn")));
}

function httpsUrl(raw: string): URL | undefined {
  const url = URL.canParse(raw) ? new URL(raw) : undefined;
  return url?.protocol === "https:" && !url.username && !url.password ? url : undefined;
}

/** A workbench page owned by the desktop window, independent of agent sessions. */
export class TeamSkillsView {
  private view: WebContentsView | undefined;
  private dispose: (() => void) | undefined;

  async handle(owner: BrowserWindow, request: TeamSkillsViewRequest): Promise<void> {
    switch (request?.action) {
      case "close":
        this.close();
        return;
      case "present": {
        const rect = request.bounds;
        if (rect !== null && (!rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)
          || rect.width < 0 || rect.height < 0 || [rect.x, rect.y, rect.width, rect.height].some(n => Math.abs(n) > 100000))) {
          throw new Error("Invalid team skills view bounds");
        }
        if (this.view) presentNativeView(owner, this.view, rect);
        return;
      }
      case "open":
        this.close();
        break;
      default:
        throw new Error("Unknown team skills view request");
    }

    const profile = session.fromPartition("persist:lxe-workbench-team-skills");
    profile.setPermissionCheckHandler(() => false);
    profile.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    profile.setDevicePermissionHandler(() => false);
    profile.setDisplayMediaRequestHandler((_request, callback) => callback({}));
    const view = new WebContentsView({ webPreferences: {
      session: profile, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true,
    } });
    this.view = view;
    view.setVisible(false);
    owner.contentView.addChildView(view);
    const guest = view.webContents;
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

    const dashboard = owner.webContents;
    const onNavigation = (event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>) => {
      if (event.isMainFrame && !event.isSameDocument) this.close();
    };
    dashboard.on("did-start-navigation", onNavigation);
    dashboard.once("render-process-gone", this.close);
    owner.once("closed", this.close);
    this.dispose = () => {
      owner.off("closed", this.close);
      dashboard.off("did-start-navigation", onNavigation);
      dashboard.off("render-process-gone", this.close);
      if (!owner.isDestroyed()) owner.contentView.removeChildView(view);
      if (!guest.isDestroyed()) guest.close({ waitForBeforeUnload: false });
    };
    await guest.loadURL(TEAM_SKILLS_URL);
  }

  readonly close = (): void => {
    const dispose = this.dispose;
    this.dispose = undefined;
    this.view = undefined;
    dispose?.();
  };
}
