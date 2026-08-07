import { join } from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  powerMonitor,
  protocol,
  safeStorage,
  session,
  shell,
  Tray,
} from "electron";
import { createLogger } from "@lxe/core";
import type {
  DashboardRpcCall,
  DashboardRpcOperation,
  DashboardRpcResult,
  DesktopCloudActivationInput,
  DesktopCloudDestination,
  DesktopCloudState,
  DesktopConversationActivityPayload,
  DesktopConversationEvent,
  DesktopConversationStreamBatch,
  DesktopConversationStreamEvent,
  DesktopDashboardInvalidation,
  DesktopHealth,
  DesktopLocalModelCredentialInput,
  DesktopModelProvider,
  DesktopSetupInput,
  DesktopSetupState,
  DesktopSyntheticPerformerTask,
} from "@lxe/desktop-protocol";
import {
  developmentSecretEnvironment,
  loadEnvironmentFiles,
} from "@lxe/gateway/desktop";
import { IPC_CHANNELS } from "./ipc-channels";
import { registerDashboardProtocol } from "./main/app-protocol";
import { createTrayIcon } from "./main/brand";
import { resolveDesktopBrandAssets } from "./main/brand-assets";
import { DesktopConversationAttachmentService } from "./main/conversation-attachments";
import { DesktopCloudEnrollmentManager } from "./main/cloud-enrollment";
import { resolveCloudDestinationUrl } from "./main/cloud-destinations";
import { DesktopConfigStore } from "./main/config-store";
import { DesktopCloudService } from "./main/desktop-cloud";
import { resolvePreviewDataServerTarget } from "./main/data-server-policy";
import {
  ALL_DASHBOARD_DATA_DOMAINS,
  DashboardInvalidationBatcher,
  dashboardDomainsForMutation,
} from "./main/dashboard-invalidation";
import { DesktopGateway } from "./main/desktop-gateway";
import { editableContextMenuTemplate } from "./main/edit-context-menu";
import { DesktopLoggingManager } from "./main/logging";
import { registerDesktopIpc, type DesktopIpcApplication } from "./main/ipc";
import {
  isAllowedDesktopNavigation,
  isExternallyOpenableUrl,
  resolveDesktopLaunchMode,
  usesPackagedRuntime,
  usesProductionRenderer,
} from "./main/launch-mode";
import { bootstrapDesktopState } from "./main/migration";
import { resolveDesktopPaths } from "./main/paths";
import { configureElectronRuntimeState, prepareDesktopRuntimeState } from "./main/runtime-state";
import { reportDesktopStartupFailure } from "./main/startup-failure";
import { DesktopInputAssetsService } from "./main/input-assets";
import { DesktopSyntheticPerformerService } from "./main/synthetic-performer";
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
let activeCloud: DesktopCloudService | undefined;
let activeInvalidationBatcher: DashboardInvalidationBatcher | undefined;
let activeLogging: DesktopLoggingManager | undefined;
let activeSyntheticPerformer: DesktopSyntheticPerformerService | undefined;
let activeConversationAttachments: DesktopConversationAttachmentService | undefined;
let removeCloudResumeListener: (() => void) | undefined;

const shutdownApplication = (exitCode = 0): Promise<void> => {
  if (shutdownPromise) return shutdownPromise;
  quitting = true;
  shutdownPromise = (async () => {
    removeCloudResumeListener?.();
    removeCloudResumeListener = undefined;
    try {
      await activeCloud?.stop();
    } catch (error) {
      logger.error("desktop_cloud_stop_failed", { error });
    }
    activeCloud = undefined;
    try {
      await activeSyntheticPerformer?.stop();
    } catch (error) {
      logger.error("desktop_synthetic_performer_stop_failed", { error });
    }
    activeSyntheticPerformer = undefined;
    activeConversationAttachments?.clear();
    activeConversationAttachments = undefined;
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
  const sourceEnvironment = packagedRuntime
    ? {}
    : loadEnvironmentFiles({ paths: [join(paths.sourceRoot, ".env")], initial: {} });
  const sourceSecretEnvironment = packagedRuntime
    ? {}
    : developmentSecretEnvironment({ ...sourceEnvironment, ...desktopEnvironment });
  const config = new DesktopConfigStore(
    paths.dataRoot,
    paths.defaultWorkspaceRoot,
    safeStorage,
    { platform: desktopPlatform, secretEnvironment: sourceSecretEnvironment },
  );
  const previewCloudTarget = launchMode === "preview"
    ? resolvePreviewDataServerTarget({
        ...config.environment(),
        ...desktopEnvironment,
      })
    : undefined;
  const broadcastHealth = (health: DesktopHealth): void => {
    for (const browserWindow of BrowserWindow.getAllWindows()) {
      if (!browserWindow.isDestroyed()) browserWindow.webContents.send(IPC_CHANNELS.statusChanged, health);
    }
  };
  const broadcastCloudState = (state: DesktopCloudState): void => {
    for (const browserWindow of BrowserWindow.getAllWindows()) {
      if (!browserWindow.isDestroyed()) browserWindow.webContents.send(IPC_CHANNELS.cloudStateChanged, state);
    }
  };
  const broadcastConversationActivity = (activity: DesktopConversationActivityPayload): void => {
    const event: DesktopConversationEvent = { activity };
    for (const browserWindow of BrowserWindow.getAllWindows()) {
      if (!browserWindow.isDestroyed()) browserWindow.webContents.send(IPC_CHANNELS.conversationEvent, event);
    }
  };
  const broadcastConversationStream = (batch: DesktopConversationStreamBatch): void => {
    const event: DesktopConversationStreamEvent = { batch };
    for (const browserWindow of BrowserWindow.getAllWindows()) {
      if (!browserWindow.isDestroyed()) {
        browserWindow.webContents.send(IPC_CHANNELS.conversationStreamEvent, event);
      }
    }
  };
  const broadcastSyntheticPerformerTask = (task: DesktopSyntheticPerformerTask): void => {
    for (const browserWindow of BrowserWindow.getAllWindows()) {
      if (!browserWindow.isDestroyed()) {
        browserWindow.webContents.send(IPC_CHANNELS.syntheticPerformerTaskChanged, task);
      }
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
  let cloud: DesktopCloudService | undefined;
  const logging = new DesktopLoggingManager({
    dataRoot: paths.dataRoot,
    environment: () => ({
      ...desktopEnvironment,
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
  const conversationAttachments = new DesktopConversationAttachmentService();
  activeConversationAttachments = conversationAttachments;
  gateway = new DesktopGateway({
    paths,
    config,
    version: app.getVersion(),
    packaged: packagedRuntime,
    desktopLoggingStatus: () => logging.status(),
    attachments: conversationAttachments,
    allowedSkillTypes: () => cloud?.allowedSkillTypes()
      ?? config.cloudPermissionSnapshot()?.allowed_skill_types
      ?? [],
    onHealthChanged: broadcastHealth,
    onDashboardInvalidated: (domains, sessionIds) => invalidations.push(domains, sessionIds),
    onConversationActivity: broadcastConversationActivity,
    onConversationStreamBatch: broadcastConversationStream,
    onManagedLlmAuthenticationFailure: async (revision) => {
      config.invalidateManagedLlmCredential(revision);
      const credential = config.managedLlmCredential();
      if (credential) await gateway.updateManagedLlmCredential(credential);
      invalidations.push(["models"]);
      await cloud?.retry();
    },
  });
  activeGateway = gateway;
  const cloudLogger = logger.child({ subsystem: "cloud_enrollment" });
  cloud = new DesktopCloudService({
    dataRoot: paths.dataRoot,
    supported: packagedRuntime && desktopPlatform === "win32" && process.arch === "x64",
    ...(previewCloudTarget ? { previewTarget: previewCloudTarget } : {}),
    config,
    enrollments: new DesktopCloudEnrollmentManager(),
    logger: cloudLogger,
    provisioner: new WindowsWireGuardProvisioner({
      platform: process.platform,
      arch: process.arch,
      packaged: packagedRuntime,
      dataRoot: paths.dataRoot,
      resourcesPath: process.resourcesPath,
      logger: cloudLogger,
    }),
    onConfigured: async () => {
      await gateway.restart();
      invalidations.push(ALL_DASHBOARD_DATA_DOMAINS);
      broadcastHealth(gateway.health());
    },
    onPermissionChanged: (allowedSkillTypes) =>
      gateway.updateSkillPermissions(allowedSkillTypes),
    onManagedLlmCredentialChanged: async (credential) => {
      if (gateway.health().gateway === "stopped") await gateway.start();
      await gateway.updateManagedLlmCredential(credential);
      if (config.state().complete) await gateway.syncModelConfiguration();
      invalidations.push(["models"]);
      broadcastHealth(gateway.health());
    },
    onStateChanged: broadcastCloudState,
  });
  activeCloud = cloud;
  const syntheticPerformer = new DesktopSyntheticPerformerService({
    platform: process.platform,
    pythonPath: paths.managedPythonPath,
    exifToolPath: paths.exifToolPath,
    dataRoot: paths.dataRoot,
    managedPath: paths.managedPath,
    onTaskChanged: broadcastSyntheticPerformerTask,
    onStderr: (line) => {
      if (line.trim()) process.stderr.write(`[lxeskill-media] ${line}\n`);
    },
  });
  activeSyntheticPerformer = syntheticPerformer;
  const inputAssets = new DesktopInputAssetsService({
    platform: process.platform,
    pythonPath: paths.managedPythonPath,
    dataRoot: paths.dataRoot,
    managedPath: paths.managedPath,
  });
  const checkCloudAfterResume = (): void => { void cloud.check(); };
  powerMonitor.on("resume", checkCloudAfterResume);
  removeCloudResumeListener = () => powerMonitor.removeListener("resume", checkCloudAfterResume);
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
    saveLocalModelCredential: async (
      input: DesktopLocalModelCredentialInput,
    ): Promise<DesktopSetupState> => {
      const previousEnvironment = config.environment();
      const wasComplete = config.state().complete;
      const state = config.saveLocalModelCredential(input);
      const runtimeConfigurationChanged = JSON.stringify(previousEnvironment) !== JSON.stringify(config.environment());
      if (!wasComplete) await gateway.start();
      if (state.complete && runtimeConfigurationChanged) await gateway.syncModelConfiguration();
      invalidations.push(ALL_DASHBOARD_DATA_DOMAINS);
      broadcastHealth(gateway.health());
      return state;
    },
    deleteLocalModelCredential: async (
      provider: DesktopModelProvider,
    ): Promise<DesktopSetupState> => {
      const previousEnvironment = config.environment();
      const state = config.deleteLocalModelCredential(provider);
      const runtimeConfigurationChanged = JSON.stringify(previousEnvironment) !== JSON.stringify(config.environment());
      if (state.complete && runtimeConfigurationChanged) await gateway.syncModelConfiguration();
      invalidations.push(ALL_DASHBOARD_DATA_DOMAINS);
      broadcastHealth(gateway.health());
      return state;
    },
    previewCloudEnrollment: (filePath) => cloud.select(filePath),
    activateCloudEnrollment: (input: DesktopCloudActivationInput) => cloud.activate(input),
    getCloudState: () => cloud.state(),
    retryCloudConnection: () => cloud.retry(),
    openCloudDestination: async (destination: DesktopCloudDestination): Promise<void> => {
      const state = cloud.state();
      const dataServerUrl = previewCloudTarget?.dataServerUrl
        ?? config.cloudConfiguration().data_server_url;
      await shell.openExternal(resolveCloudDestinationUrl({
        configured: state.configured,
        connection: state.connection,
        dataServerUrl,
        destination,
        desktopFeatures: state.desktop_features,
      }));
    },
    logsDirectory: join(paths.dataRoot, "logs"),
    registerSyntheticPerformerSources: (kind, selectedPaths) =>
      syntheticPerformer.registerSources(kind, selectedPaths),
    registerSyntheticPerformerOutput: (path) => syntheticPerformer.registerOutput(path),
    startSyntheticPerformerTask: (input) => syntheticPerformer.start(input),
    getSyntheticPerformerTask: () => syntheticPerformer.current(),
    cancelSyntheticPerformerTask: (taskId) => syntheticPerformer.cancel(taskId),
    syntheticPerformerOutputPath: (taskId) => syntheticPerformer.outputPath(taskId),
    listInputAssets: () => inputAssets.list(),
    inputAssetSlotDirectory: (slot) => inputAssets.directoryFor(slot),
    registerConversationFiles: (selectedPaths) => conversationAttachments.register(selectedPaths),
    discardConversationFiles: (attachmentIds) => conversationAttachments.discard(attachmentIds),
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

  try {
    await gateway.start();
  } catch (error) {
    logger.error("desktop_gateway_start_failed", { error });
  }
  void cloud.start();

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
  window.webContents.on("context-menu", (_event, params) => {
    const template = editableContextMenuTemplate(params);
    const ownerWindow = window;
    if (!ownerWindow || !template.length) return;
    Menu.buildFromTemplate(template).popup({ window: ownerWindow });
  });
  // The Renderer never gets to open a window of its own. A plain web link still
  // has to reach the user, so it goes to the system browser instead — where it
  // lands outside the application, with none of its privileges.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternallyOpenableUrl(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
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
