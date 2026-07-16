import { homedir } from "node:os";
import { join } from "node:path";
import {
  app,
  BrowserWindow,
  Menu,
  protocol,
  safeStorage,
  session,
  Tray,
} from "electron";
import type {
  DashboardTransportRequest,
  DesktopHealth,
  DesktopSetupInput,
  DesktopSetupState,
} from "@lxe/desktop-protocol";
import type { JsonValue } from "@lxe/protocol";
import { IPC_CHANNELS } from "./ipc-channels";
import { registerDashboardProtocol } from "./main/app-protocol";
import { createTrayIcon } from "./main/brand";
import { DesktopConfigStore } from "./main/config-store";
import { DesktopGateway } from "./main/desktop-gateway";
import { registerDesktopIpc, type DesktopIpcApplication } from "./main/ipc";
import { bootstrapDesktopState, migrateLegacyArtifacts } from "./main/migration";
import { resolveDesktopPaths } from "./main/paths";
import { desktopWindowAppearance } from "./main/window-options";
import { normalizeDesktopPlatform } from "./platform";

protocol.registerSchemesAsPrivileged([{
  scheme: "app",
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: false,
  },
}]);

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();
const desktopPlatform = normalizeDesktopPlatform(process.platform);

let window: BrowserWindow | undefined;
let tray: Tray | undefined;
let quitting = false;
let shutdownComplete = false;
let shutdownPromise: Promise<void> | undefined;
let removeIpcHandlers: (() => void) | undefined;
let activeGateway: DesktopGateway | undefined;

const isAllowedNavigation = (target: string, developmentUrl: string): boolean => {
  try {
    const parsed = new URL(target);
    if (app.isPackaged) return parsed.protocol === "app:" && parsed.hostname === "lxe";
    return parsed.origin === new URL(developmentUrl).origin;
  } catch {
    return false;
  }
};

const shutdownApplication = (exitCode = 0): Promise<void> => {
  if (shutdownPromise) return shutdownPromise;
  quitting = true;
  shutdownPromise = (async () => {
    try {
      await activeGateway?.stop();
    } catch (error) {
      process.stderr.write(`Desktop Gateway failed to stop: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    removeIpcHandlers?.();
    removeIpcHandlers = undefined;
    tray?.destroy();
    tray = undefined;
    shutdownComplete = true;
    if (exitCode === 0) app.quit();
    else app.exit(exitCode);
  })();
  return shutdownPromise;
};

async function bootstrap(): Promise<void> {
  const paths = resolveDesktopPaths({
    packaged: app.isPackaged,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    userDataPath: app.getPath("userData"),
    documentsPath: app.getPath("documents"),
  });
  bootstrapDesktopState(paths.resourceRoot, paths.dataRoot);
  migrateLegacyArtifacts({
    legacyRoot: join(homedir(), ".lxe_agent"),
    dataRoot: paths.dataRoot,
  });
  const config = new DesktopConfigStore(
    paths.dataRoot,
    paths.defaultWorkspaceRoot,
    safeStorage,
  );
  const broadcastHealth = (health: DesktopHealth): void => {
    for (const browserWindow of BrowserWindow.getAllWindows()) {
      if (!browserWindow.isDestroyed()) browserWindow.webContents.send(IPC_CHANNELS.statusChanged, health);
    }
  };
  const gateway = new DesktopGateway({
    paths,
    config,
    version: app.getVersion(),
    packaged: app.isPackaged,
    onHealthChanged: broadcastHealth,
  });
  activeGateway = gateway;
  const ipcApplication: DesktopIpcApplication = {
    dashboardRequest: (request: DashboardTransportRequest): Promise<JsonValue> =>
      gateway.dashboardRequest(request),
    getHealth: () => gateway.health(),
    restartAgent: () => gateway.restartAgent(),
    getSetupState: () => config.state(),
    saveSetup: async (input: DesktopSetupInput): Promise<DesktopSetupState> => {
      const state = config.save(input);
      await gateway.restart();
      broadcastHealth(gateway.health());
      return state;
    },
  };
  removeIpcHandlers = registerDesktopIpc(ipcApplication);

  if (app.isPackaged) {
    registerDashboardProtocol(paths.dashboardRoot);
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      if (!details.url.startsWith("app://lxe/")) {
        callback(details.responseHeaders ? { responseHeaders: details.responseHeaders } : {});
        return;
      }
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          "Content-Security-Policy": [
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
            + "img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; "
            + "base-uri 'self'; frame-ancestors 'none'",
          ],
        },
      });
    });
  }

  if (config.state().complete) {
    try {
      await gateway.start();
    } catch (error) {
      process.stderr.write(`Desktop Gateway failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }

  window = new BrowserWindow({
    ...desktopWindowAppearance(desktopPlatform),
    title: "LXE Agent",
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: "#faf8f5",
    webPreferences: {
      preload: join(import.meta.dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  if (desktopPlatform !== "darwin") window.setMenuBarVisibility(false);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    const developmentUrl = String(process.env.LXE_DASHBOARD_DEV_URL ?? "http://127.0.0.1:5173");
    const allowed = isAllowedNavigation(url, developmentUrl);
    if (!allowed) event.preventDefault();
  });
  window.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    window?.hide();
  });
  window.on("closed", () => { window = undefined; });
  window.once("ready-to-show", () => window?.show());
  await window.loadURL(
    app.isPackaged
      ? "app://lxe/"
      : String(process.env.LXE_DASHBOARD_DEV_URL ?? "http://127.0.0.1:5173"),
  );

  const showWindow = (): void => {
    if (!window) return;
    window.show();
    window.focus();
  };
  tray = new Tray(createTrayIcon(desktopPlatform));
  tray.setToolTip("LXE Agent");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "打开 LXE Agent", click: showWindow },
    { type: "separator" },
    { label: "退出 LXE", click: () => { void shutdownApplication(); } },
  ]));
  tray.on("click", showWindow);

  app.on("activate", showWindow);
  app.on("second-instance", showWindow);
}

if (hasSingleInstanceLock) {
  app.whenReady().then(() => {
    app.setAppUserModelId("com.lxe.agent");
    if (desktopPlatform === "win32") Menu.setApplicationMenu(null);
    return bootstrap();
  }).catch((error) => {
    process.stderr.write(`LXE Agent startup failed: ${error instanceof Error ? error.stack : String(error)}\n`);
    void shutdownApplication(1);
  });
}

app.on("window-all-closed", () => {
  // The desktop Gateway remains active in the tray on Windows and macOS.
});

app.on("before-quit", (event) => {
  if (shutdownComplete) return;
  event.preventDefault();
  void shutdownApplication();
});
