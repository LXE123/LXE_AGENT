import { join } from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  protocol,
  safeStorage,
  session,
  Tray,
} from "electron";
import { createLogger } from "@lxe/core";
import type {
  DashboardRpcCall,
  DashboardRpcOperation,
  DashboardRpcResult,
  DesktopCloudActivationInput,
  DesktopDashboardInvalidation,
  DesktopHealth,
  DesktopSetupInput,
  DesktopSetupState,
} from "@lxe/desktop-protocol";
import { loadProjectEnv, loadRuntimeEnv } from "@lxe/gateway/desktop";
import { IPC_CHANNELS } from "./ipc-channels";
import { registerDashboardProtocol } from "./main/app-protocol";
import { createTrayIcon } from "./main/brand";
import { resolveDesktopBrandAssets } from "./main/brand-assets";
import { DesktopConfigImportManager } from "./main/config-import";
import { applyDesktopConfigImport } from "./main/config-import-application";
import { DesktopCloudEnrollmentManager } from "./main/cloud-enrollment";
import { DesktopConfigStore } from "./main/config-store";
import { DesktopCloudService } from "./main/desktop-cloud";
import {
  ALL_DASHBOARD_DATA_DOMAINS,
  DashboardInvalidationBatcher,
  dashboardDomainsForMutation,
} from "./main/dashboard-invalidation";
import { DesktopGateway } from "./main/desktop-gateway";
import { DesktopLoggingManager } from "./main/logging";
import { registerDesktopIpc, type DesktopIpcApplication } from "./main/ipc";
import {
  isAllowedDesktopNavigation,
  resolveDesktopLaunchMode,
  usesPackagedRuntime,
  usesProductionRenderer,
} from "./main/launch-mode";
import { bootstrapDesktopState } from "./main/migration";
import { resolveDesktopPaths } from "./main/paths";
import { configureElectronRuntimeState, prepareDesktopRuntimeState } from "./main/runtime-state";
import { reportDesktopStartupFailure } from "./main/startup-failure";
import { desktopWindowAppearance } from "./main/window-options";
import { WindowsWireGuardProvisioner } from "./main/wireguard-provisioner";
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
const desktopPaths = resolveDesktopPaths({
  packaged: packagedRuntime,
  appPath: app.getAppPath(),
  executablePath: process.execPath,
  resourcesPath: process.resourcesPath,
  environment: process.env,
});
let runtimeStateReady = false;
try {
  const runtimeState = prepareDesktopRuntimeState(desktopPaths.dataRoot);
  configureElectronRuntimeState(app, runtimeState);
  runtimeStateReady = true;
  if (launchMode === "preview") {
    process.stderr.write(
      `LXE Agent production preview: app://lxe/ with source runtime\nPreview data: ${desktopPaths.dataRoot}\n`,
    );
  }
} catch (error) {
  reportDesktopStartupFailure(error, {
    writeStderr: (message) => process.stderr.write(message),
    showError: (title, detail) => dialog.showErrorBox(title, detail),
  });
  app.exit(1);
}

const hasSingleInstanceLock = runtimeStateReady && app.requestSingleInstanceLock();
if (runtimeStateReady && !hasSingleInstanceLock) app.quit();
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
  const desktopEnvironment = process.env;
  const paths = desktopPaths;
  const brandAssets = resolveDesktopBrandAssets({
    packaged: app.isPackaged,
    platform: desktopPlatform,
    resourcesPath: process.resourcesPath,
    sourceRoot: paths.sourceRoot,
  });
  bootstrapDesktopState(paths.mcpDefaultPath, paths.dataRoot);
  const config = new DesktopConfigStore(
    paths.dataRoot,
    paths.defaultWorkspaceRoot,
    safeStorage,
    { platform: desktopPlatform },
  );
  config.migrateLegacyEnvironment({
    environment: {
      ...loadRuntimeEnv({ runtimeEnvPath: paths.runtimeEnvPath, initial: desktopEnvironment }),
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
      ...loadRuntimeEnv({ runtimeEnvPath: paths.runtimeEnvPath, initial: desktopEnvironment }),
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
  const cloud = new DesktopCloudService({
    dataRoot: paths.dataRoot,
    supported: packagedRuntime && desktopPlatform === "win32" && process.arch === "x64",
    config,
    enrollments: new DesktopCloudEnrollmentManager(),
    provisioner: new WindowsWireGuardProvisioner({
      platform: process.platform,
      arch: process.arch,
      packaged: packagedRuntime,
      dataRoot: paths.dataRoot,
      resourcesPath: process.resourcesPath,
    }),
    onConfigured: async () => {
      await gateway.restart();
      invalidations.push(ALL_DASHBOARD_DATA_DOMAINS);
      broadcastHealth(gateway.health());
    },
  });
  const ipcApplication: DesktopIpcApplication = {
    dashboardCall: async <O extends DashboardRpcOperation>(
      call: DashboardRpcCall<O>,
    ): Promise<DashboardRpcResult<O>> => {
      const result = await gateway.dashboardCall(call);
      invalidations.push(dashboardDomainsForMutation(call.operation));
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
      const previousEnvironment = config.environment();
      const wasComplete = config.state().complete;
      const state = config.save(input);
      logging.configure();
      const nextEnvironment = config.environment();
      const runtimeConfigurationChanged = JSON.stringify(previousEnvironment) !== JSON.stringify(nextEnvironment);
      if (!wasComplete || runtimeConfigurationChanged) await gateway.restart();
      invalidations.push(ALL_DASHBOARD_DATA_DOMAINS);
      broadcastHealth(gateway.health());
      return state;
    },
    previewConfigImport: (filePath) => configImports.select(filePath),
    applyConfigImport: (importId) => applyDesktopConfigImport({
      importId,
      apply: (selectedImportId) => configImports.apply(selectedImportId),
      currentEnvironment: () => config.environment(),
      currentState: () => config.state(),
      configureLogging: () => logging.configure(),
      restartGateway: () => gateway.restart(),
      stopGateway: () => gateway.stop(),
      invalidateDashboard: () => invalidations.push(ALL_DASHBOARD_DATA_DOMAINS),
      broadcastHealth: () => broadcastHealth(gateway.health()),
      logger,
    }),
    discardConfigImport: (importId) => configImports.discard(importId),
    previewCloudEnrollment: (filePath) => cloud.select(filePath),
    activateCloudEnrollment: (input: DesktopCloudActivationInput) => cloud.activate(input),
    getCloudState: () => cloud.state(),
    retryCloudConnection: () => cloud.retry(),
    logsDirectory: join(paths.dataRoot, "logs"),
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
  if (config.cloudConfiguration().managed) void cloud.retry();

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
    reportDesktopStartupFailure(error, {
      writeStderr: (message) => process.stderr.write(message),
      showError: (title, detail) => dialog.showErrorBox(title, detail),
    });
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
