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
import { createLogger } from "@lxe/core";
import type {
  DashboardTransportRequest,
  DesktopDashboardInvalidation,
  DesktopHealth,
  DesktopSetupInput,
  DesktopSetupState,
} from "@lxe/desktop-protocol";
import type { JsonValue } from "@lxe/protocol";
import { loadProjectEnv } from "@lxe/gateway/desktop";
import { IPC_CHANNELS } from "./ipc-channels";
import { registerDashboardProtocol } from "./main/app-protocol";
import { createTrayIcon } from "./main/brand";
import { resolveDesktopBrandAssets } from "./main/brand-assets";
import { DesktopConfigImportManager } from "./main/config-import";
import { DesktopConfigStore } from "./main/config-store";
import {
  ALL_DASHBOARD_DATA_DOMAINS,
  DashboardInvalidationBatcher,
  dashboardDomainsForMutation,
} from "./main/dashboard-invalidation";
import { DesktopGateway } from "./main/desktop-gateway";
import { DesktopLoggingManager } from "./main/logging";
import { registerDesktopIpc, type DesktopIpcApplication } from "./main/ipc";
import {
  desktopPreviewDataRoot,
  isAllowedDesktopNavigation,
  resolveDesktopLaunchMode,
  usesPackagedRuntime,
  usesProductionRenderer,
} from "./main/launch-mode";
import { bootstrapDesktopState, migrateLegacyArtifacts } from "./main/migration";
import { resolveDesktopPaths } from "./main/paths";
import { desktopWindowAppearance } from "./main/window-options";
import { normalizeDesktopPlatform } from "./platform";

const logger = createLogger("desktop.main");

protocol.registerSchemesAsPrivileged([{
  scheme: "app",
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: false,
  },
}]);

const launchMode = resolveDesktopLaunchMode({
  packaged: app.isPackaged,
  previewFlag: process.env.LXE_DESKTOP_PREVIEW,
});
const productionRenderer = usesProductionRenderer(launchMode);
const packagedRuntime = usesPackagedRuntime(launchMode);
const previewDataRoot = launchMode === "preview"
  ? desktopPreviewDataRoot(app.getPath("appData"))
  : undefined;
if (previewDataRoot) {
  app.setPath("userData", previewDataRoot);
  process.stderr.write(`LXE Agent production preview: app://lxe/ with source runtime\nPreview data: ${previewDataRoot}\n`);
}

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
let activeInvalidationBatcher: DashboardInvalidationBatcher | undefined;
let activeLogging: DesktopLoggingManager | undefined;

const shutdownApplication = (exitCode = 0): Promise<void> => {
  if (shutdownPromise) return shutdownPromise;
  quitting = true;
  shutdownPromise = (async () => {
    try {
      await activeGateway?.stop();
    } catch (error) {
      logger.error("desktop_gateway_stop_failed", { error });
    }
    removeIpcHandlers?.();
    removeIpcHandlers = undefined;
    tray?.destroy();
    activeInvalidationBatcher?.dispose();
    activeInvalidationBatcher = undefined;
    tray = undefined;
    logger.info("desktop_stopped", { exit_code: exitCode });
    const logging = activeLogging;
    activeLogging = undefined;
    await logging?.close();
    shutdownComplete = true;
    if (exitCode === 0) app.quit();
    else app.exit(exitCode);
  })();
  return shutdownPromise;
};

async function bootstrap(): Promise<void> {
  const desktopEnvironment = previewDataRoot
    ? { ...process.env, LXE_DATA_ROOT: previewDataRoot }
    : process.env;
  const paths = resolveDesktopPaths({
    packaged: packagedRuntime,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    userDataPath: app.getPath("userData"),
    documentsPath: app.getPath("documents"),
    environment: desktopEnvironment,
  });
  const brandAssets = resolveDesktopBrandAssets({
    packaged: app.isPackaged,
    platform: desktopPlatform,
    resourcesPath: process.resourcesPath,
    sourceRoot: paths.sourceRoot,
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
    { platform: desktopPlatform },
  );
  config.migrateLegacyEnvironment({
    environment: {
      ...loadProjectEnv({ projectRoot: paths.resourceRoot, initial: desktopEnvironment }),
      ...loadProjectEnv({ projectRoot: paths.dataRoot, initial: {} }),
    },
    managedFiles: [join(paths.dataRoot, ".env"), join(paths.dataRoot, ".env.local")],
  });
  const configImports = new DesktopConfigImportManager(config);
  const broadcastHealth = (health: DesktopHealth): void => {
    for (const browserWindow of BrowserWindow.getAllWindows()) {
      if (!browserWindow.isDestroyed()) browserWindow.webContents.send(IPC_CHANNELS.statusChanged, health);
    }
  };
  const broadcastInvalidation = (invalidation: DesktopDashboardInvalidation): void => {
    for (const browserWindow of BrowserWindow.getAllWindows()) {
      if (!browserWindow.isDestroyed()) {
        browserWindow.webContents.send(IPC_CHANNELS.dashboardInvalidated, invalidation);
      }
    }
  };
  let gateway: DesktopGateway;
  const logging = new DesktopLoggingManager({
    dataRoot: paths.dataRoot,
    environment: () => ({
      ...loadProjectEnv({ projectRoot: paths.resourceRoot, initial: desktopEnvironment }),
      ...loadProjectEnv({ projectRoot: paths.dataRoot, initial: {} }),
      ...config.environment(),
    }),
    onStatusChange: () => {
      if (gateway) broadcastHealth(gateway.health());
    },
  });
  activeLogging = logging;
  logging.configure();
  const invalidations = new DashboardInvalidationBatcher(broadcastInvalidation);
  activeInvalidationBatcher = invalidations;
  gateway = new DesktopGateway({
    paths,
    config,
    version: app.getVersion(),
    packaged: packagedRuntime,
    desktopLoggingStatus: () => logging.status(),
    onHealthChanged: broadcastHealth,
    onDashboardInvalidated: (domains, sessionIds) => invalidations.push(domains, sessionIds),
  });
  activeGateway = gateway;
  const ipcApplication: DesktopIpcApplication = {
    dashboardRequest: async (request: DashboardTransportRequest): Promise<JsonValue> => {
      const result = await gateway.dashboardRequest(request);
      if (request.method === "PATCH") {
        invalidations.push(dashboardDomainsForMutation(request.path));
      }
      return result;
    },
    getHealth: () => gateway.health(),
    restartAgent: async () => {
      const health = await gateway.restartAgent();
      invalidations.push(ALL_DASHBOARD_DATA_DOMAINS);
      return health;
    },
    getSetupState: () => config.state(),
    saveSetup: async (input: DesktopSetupInput): Promise<DesktopSetupState> => {
      const state = config.save(input);
      logging.configure();
      await gateway.restart();
      invalidations.push(ALL_DASHBOARD_DATA_DOMAINS);
      broadcastHealth(gateway.health());
      return state;
    },
    previewConfigImport: (filePath) => configImports.select(filePath),
    applyConfigImport: async (importId) => {
      const result = configImports.apply(importId);
      logging.configure();
      if (result.state.complete) await gateway.restart();
      else await gateway.stop();
      invalidations.push(ALL_DASHBOARD_DATA_DOMAINS);
      broadcastHealth(gateway.health());
      return result;
    },
    discardConfigImport: (importId) => configImports.discard(importId),
    logsDirectory: join(paths.dataRoot, "var", "logs"),
  };
  removeIpcHandlers = registerDesktopIpc(ipcApplication);

  if (productionRenderer) {
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
      logger.error("desktop_gateway_start_failed", { error });
    }
  }

  window = new BrowserWindow({
    ...desktopWindowAppearance(desktopPlatform),
    ...(desktopPlatform === "darwin" ? {} : { icon: brandAssets.appIconPath }),
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
    const allowed = isAllowedDesktopNavigation(url, launchMode, developmentUrl);
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
    productionRenderer
      ? "app://lxe/"
      : String(process.env.LXE_DASHBOARD_DEV_URL ?? "http://127.0.0.1:5173"),
  );

  const showWindow = (): void => {
    if (!window) return;
    window.show();
    window.focus();
  };
  tray = new Tray(createTrayIcon(desktopPlatform, brandAssets));
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
    logger.error("desktop_startup_failed", { error });
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
