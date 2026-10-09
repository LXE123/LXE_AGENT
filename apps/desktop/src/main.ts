import { sendEditingShortcut, titlebarMenuTemplate } from "./main/titlebar-menu";
import { WINDOWS_TITLEBAR_COLOURS } from "./main/window-options";
import type { DesktopTitlebarAction } from "@lxe/desktop-protocol";
import { ManualToolsService } from "./main/manual-tools/service";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DeepSeekBalanceService } from "./main/deepseek-balance";
import { UpdateJournal } from "./main/update-journal";
import { readFileSync } from "node:fs";
import { prepareUpdate } from "./main/update-preparation";
import { DesktopUpdateService } from "./main/update-service";
import { ElectronUpdateInstaller } from "./main/update-electron";
import { DesktopUpdateApi, UpdateConnectionMonitor, updateConnectionReady } from "./main/update-api";
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
import { DASHBOARD_CSP, HTML_PREVIEW_SCHEME, registerHtmlPreviewProtocol } from "./main/file-preview/html-protocol";
import { trackFilePreviewLifecycle } from "./main/file-preview/lifecycle";
import { createTrayIcon } from "./main/brand";
import { resolveDesktopBrandAssets } from "./main/brand-assets";
import { DesktopConversationAttachmentService } from "./main/conversation-attachments";
import { prepareClipboardScreenshot } from "./main/inbound-image";
import { DesktopCloudEnrollmentManager } from "./main/cloud-enrollment";
import { resolveCloudDestinationUrl } from "./main/cloud-destinations";
import { DesktopConfigStore } from "./main/config-store";
import { attachmentThumbnail } from "./main/attachment-thumbnail";
import { DesktopCloudContextClient } from "./main/cloud-context";
import { DesktopCloudService } from "./main/desktop-cloud";
import {
  ALL_DASHBOARD_DATA_DOMAINS,
  DashboardInvalidationBatcher,
  dashboardDomainsForMutation,
} from "./main/dashboard-invalidation";
import { DesktopGateway } from "./main/desktop-gateway";
import { AuthBrowserHost } from "./main/auth-browser-host";
import { ElectronAuthBrowserSession } from "./main/auth-browser-session";
import { editableContextMenuTemplate } from "./main/edit-context-menu";
import { DesktopLoggingManager } from "./main/logging";
import { MacOSWireGuardProvisioner } from "./main/macos-wireguard-provisioner";
import { registerDesktopIpc, type DesktopIpcApplication } from "./main/ipc";
import {
  isAllowedDesktopNavigation,
  isExternallyOpenableUrl,
  resolveDesktopLaunchMode,
  usesPackagedRuntime,
  usesProductionRenderer,
} from "./main/launch-mode";
import { bootstrapDesktopState, migrateLegacyArtifacts } from "./main/migration";
import { resolveDesktopPaths } from "./main/paths";
import { configureElectronRuntimeState, prepareDesktopRuntimeState } from "./main/runtime-state";
import { reportDesktopStartupFailure } from "./main/startup-failure";
import { DesktopInputAssetsService } from "./main/input-assets";
import { DesktopSyntheticPerformerService } from "./main/synthetic-performer";
import {
  DESKTOP_TITLEBAR_COLOURS,
  DESKTOP_TITLEBAR_HEIGHT,
  desktopWindowAppearance,
} from "./main/window-options";
import { WindowsWireGuardProvisioner } from "./main/wireguard-provisioner";
import { acquireDataRootLock, dataRootInitialized } from "./main/data-migration";
import { bootstrapUserData } from "./main/data-bootstrap";
import { normalizeDesktopPlatform } from "./platform";
import { MIGRATION_CREDENTIAL_ARGUMENT, runMigrationCredentialProbe, validateCredentialCopy } from "./main/data-credentials";

const credentialProbe = process.argv.find(value => value.startsWith(MIGRATION_CREDENTIAL_ARGUMENT));
if (credentialProbe !== undefined) {
  void runMigrationCredentialProbe(credentialProbe.slice(MIGRATION_CREDENTIAL_ARGUMENT.length), app, safeStorage)
    .then(() => app.exit(0)).catch(error => {
      process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
      app.exit(1);
    });
} else startDesktop();

function startDesktop(): void {

const logger = createLogger("desktop.main");

protocol.registerSchemesAsPrivileged([{
  scheme: "app",
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: false,
  },
}, HTML_PREVIEW_SCHEME]);

const launchMode = resolveDesktopLaunchMode({
  packaged: app.isPackaged,
  previewFlag: process.env.LXE_DESKTOP_PREVIEW,
});
const productionRenderer = usesProductionRenderer(launchMode);
const packagedRuntime = usesPackagedRuntime(launchMode);
const dataIdentity = packagedRuntime && process.platform === "win32"
  ? JSON.parse(readFileSync(join(app.getAppPath(), "package.json"), "utf8")) : {};
const desktopPaths = (() => { try { return resolveDesktopPaths({
  packaged: packagedRuntime,
  appPath: app.getAppPath(),
  executablePath: process.execPath,
  resourcesPath: process.resourcesPath,
  environment: process.env,
  dataDirectoryName: dataIdentity.lxeDataDirectoryName ?? "LXE Agent",
}); } catch (error) {
  reportDesktopStartupFailure(error, {writeStderr: message => process.stderr.write(message), showError: (title, detail) => dialog.showErrorBox(title, detail)});
  app.exit(1);
  throw error;
} })();
let runtimeStateReady = false;
let needsDataBootstrap = false;
let releaseDataLock: (() => void) | undefined;
app.once("quit", () => releaseDataLock?.());
try {
  needsDataBootstrap = packagedRuntime && process.platform === "win32" && !process.env.LXE_DATA_ROOT?.trim()
    && !dataRootInitialized(desktopPaths.dataRoot);
  const runtimeState = prepareDesktopRuntimeState(needsDataBootstrap ? `${desktopPaths.dataRoot}.bootstrap` : desktopPaths.dataRoot);
  configureElectronRuntimeState(app, runtimeState, needsDataBootstrap ? {} : process.env);
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

let hasSingleInstanceLock = runtimeStateReady && app.requestSingleInstanceLock();
if (runtimeStateReady && !hasSingleInstanceLock) app.quit();
if (hasSingleInstanceLock && needsDataBootstrap) {
  try { releaseDataLock = acquireDataRootLock(desktopPaths.dataRoot); }
  catch (error) {
    hasSingleInstanceLock = false;
    reportDesktopStartupFailure(error, {writeStderr: message => process.stderr.write(message), showError: (title, detail) => dialog.showErrorBox(title, detail)});
    app.exit(1);
  }
}
const desktopPlatform = normalizeDesktopPlatform(process.platform);

let window: BrowserWindow | undefined;
let tray: Tray | undefined;
let quitting = false;
let shutdownComplete = false;
let shutdownPromise: Promise<void> | undefined;
let removeIpcHandlers: (() => void) | undefined;
let activeGateway: DesktopGateway | undefined;
let manualTools: ManualToolsService | undefined;
let activeAuthBrowserHost: AuthBrowserHost | undefined;
const applicationWindows = (): BrowserWindow[] => window && !window.isDestroyed() ? [window] : [];
let activeCloud: DesktopCloudService | undefined;
let activeInvalidationBatcher: DashboardInvalidationBatcher | undefined;
let activeLogging: DesktopLoggingManager | undefined;
let activeSyntheticPerformer: DesktopSyntheticPerformerService | undefined;
let activeConversationAttachments: DesktopConversationAttachmentService | undefined;
let removeCloudResumeListener: (() => void) | undefined;

let activeUpdates: DesktopUpdateService | undefined;
let updateShutdown = false;

const shutdownApplication = (exitCode = 0): Promise<void> => {
  activeUpdates?.stop();
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
    try { await manualTools?.stop(); } catch (error) { logger.error("manual_tools_stop_failed", { error }); }
    await activeAuthBrowserHost?.stop();
    activeAuthBrowserHost = undefined;
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
  await migrateLegacyArtifacts(paths.dataRoot);
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
    {
      platform: desktopPlatform,
      secretEnvironment: sourceSecretEnvironment,
      llmConfigRoot: paths.llmConfigRoot,
    },
  );
  const usageBalance = new DeepSeekBalanceService(() => config.deepSeekBalanceCredential());
  const broadcastHealth = (health: DesktopHealth): void => {
    for (const browserWindow of applicationWindows()) {
      if (!browserWindow.isDestroyed()) browserWindow.webContents.send(IPC_CHANNELS.statusChanged, health);
    }
  };
  const updateConnection = new UpdateConnectionMonitor();
  const broadcastCloudState = (state: DesktopCloudState): void => {
    if (updateConnection.restored(state)) activeUpdates?.wake();
    for (const browserWindow of applicationWindows()) {
      if (!browserWindow.isDestroyed()) browserWindow.webContents.send(IPC_CHANNELS.cloudStateChanged, state);
    }
  };
  const broadcastConversationActivity = (activity: DesktopConversationActivityPayload): void => {
    const event: DesktopConversationEvent = { activity };
    for (const browserWindow of applicationWindows()) {
      if (!browserWindow.isDestroyed()) browserWindow.webContents.send(IPC_CHANNELS.conversationEvent, event);
    }
  };
  const broadcastConversationStream = (batch: DesktopConversationStreamBatch): void => {
    const event: DesktopConversationStreamEvent = { batch };
    for (const browserWindow of applicationWindows()) {
      if (!browserWindow.isDestroyed()) {
        browserWindow.webContents.send(IPC_CHANNELS.conversationStreamEvent, event);
      }
    }
  };
  const broadcastSyntheticPerformerTask = (task: DesktopSyntheticPerformerTask): void => {
    for (const browserWindow of applicationWindows()) {
      if (!browserWindow.isDestroyed()) {
        browserWindow.webContents.send(IPC_CHANNELS.syntheticPerformerTaskChanged, task);
      }
    }
  };
  const broadcastInvalidation = (invalidation: DesktopDashboardInvalidation): void => {
    for (const browserWindow of applicationWindows()) {
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
  const conversationAttachments = new DesktopConversationAttachmentService(undefined, undefined, {
    directory: join(paths.dataRoot, "attachments", "screenshots"),
    prepare: prepareClipboardScreenshot,
  });
  activeConversationAttachments = conversationAttachments;
  const authBrowserHost = new AuthBrowserHost(async headless => new ElectronAuthBrowserSession(headless));
  await authBrowserHost.start();
  activeAuthBrowserHost = authBrowserHost;
  gateway = new DesktopGateway({
    beforeDeleteSession: sessionId => manualTools?.closeSession(sessionId) ?? Promise.resolve(),
    paths,
    config,
    version: app.getVersion(),
    packaged: packagedRuntime,
    desktopLoggingStatus: () => logging.status(),
    attachments: conversationAttachments,
    authBrowserEnvironment: () => authBrowserHost.environment(),
    allowedSkillTypes: () => cloud?.allowedSkillTypes()
      ?? config.cloudPermissionSnapshot()?.allowed_skill_types
      ?? [],
    onHealthChanged: broadcastHealth,
    onDashboardInvalidated: (domains, sessionIds) => invalidations.push(domains, sessionIds),
    onConversationActivity: broadcastConversationActivity,
    onSessionStatus: snapshot => {
      for (const window of applicationWindows()) {
        if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.sessionStatus,snapshot);
      }
    },
    onConversationStreamBatch: broadcastConversationStream,
    onExecUpdate: update => {
      for (const browserWindow of applicationWindows()) {
        if (!browserWindow.isDestroyed()) browserWindow.webContents.send(IPC_CHANNELS.execUpdate, update);
      }
    },
    onManagedLlmAuthenticationFailure: async (revision) => {
      config.invalidateManagedLlmCredential(revision);
      const credential = config.managedLlmCredential();
      // Startup may have awaited while the identity or cache changed. Read the current value.
      await gateway.updateManagedLlmCredential(credential ? config.managedLlmCredential() : null);
      invalidations.push(["models"]);
      await cloud?.check();
    },
  });
  activeGateway = gateway;
  const cloudLogger = logger.child({ subsystem: "cloud_enrollment" });
  const cloudProvisioner = desktopPlatform === "darwin"
    ? new MacOSWireGuardProvisioner({
        platform: process.platform,
        arch: process.arch,
        packaged: packagedRuntime,
        dataRoot: paths.dataRoot,
        logger: cloudLogger,
      })
    : new WindowsWireGuardProvisioner({
        platform: process.platform,
        arch: process.arch,
        packaged: packagedRuntime,
        dataRoot: paths.dataRoot,
        resourcesPath: process.resourcesPath,
        logger: cloudLogger,
      });
  cloud = new DesktopCloudService({
    dataRoot: paths.dataRoot,
    llmConfigRoot: paths.llmConfigRoot,
    supported: cloudProvisioner.supported(),
    unsupportedMessage: "公司云端支持 Windows 10/11 x64 安装包和 Apple Silicon Mac 开发版",
    config,
    enrollments: new DesktopCloudEnrollmentManager(),
    logger: cloudLogger,
    provisioner: cloudProvisioner,
    contextClient: new DesktopCloudContextClient({ pythonPath: paths.managedPythonPath, cwd: paths.dataRoot }),
    onConfigured: async () => {
      await gateway.restart();
      invalidations.push(ALL_DASHBOARD_DATA_DOMAINS);
      broadcastHealth(gateway.health());
    },
    onPermissionChanged: (allowedSkillTypes) =>
      gateway.updateSkillPermissions(allowedSkillTypes),
    onManagedLlmCredentialChanged: async (credential) => {
      if (gateway.health().gateway === "stopped") await gateway.start();
      // Startup may have awaited while the identity or cache changed. Read the current value.
      await gateway.updateManagedLlmCredential(credential ? config.managedLlmCredential() : null);
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
  const checkCloudAfterResume = (): void => { void cloud.check(); activeUpdates?.wake(); };
  powerMonitor.on("resume", checkCloudAfterResume);
  removeCloudResumeListener = () => powerMonitor.removeListener("resume", checkCloudAfterResume);
  const updateSupported = packagedRuntime && process.platform === "win32" && process.arch === "x64";
  const updateJournal = new UpdateJournal(join(paths.dataRoot, "updates", "last-attempt.json"));
  const installedBuild = updateSupported ? JSON.parse(readFileSync(join(app.getAppPath(), "package.json"), "utf8")).lxeBuildId as string | undefined : undefined;
  const lastAttempt = updateJournal.previous(app.getVersion(), installedBuild);
  let gatewayStopStarted = false;
  const updates = new DesktopUpdateService({
    ...(lastAttempt ? {lastAttempt} : {}),
    recordAttempt: release => updateJournal.start(release.version, release.build_id),
    recordError: error => updateJournal.error(error),
    supported: updateSupported,
    configured: () => updateConnectionReady(cloud.state()),
    api: new DesktopUpdateApi(() => cloud.state(), app.getVersion(), installedBuild),
    installer: updateSupported ? new ElectronUpdateInstaller(error => activeUpdates?.recordFailure(error), message => logger.info("desktop_update_download", {message})) : {
      download: async () => { throw new Error("Updates unsupported"); },
      verify: async () => {}, install: () => {},
    },
    prepareInstall: () => prepareUpdate({
      snapshot: () => {
        const task = syntheticPerformer.current();
        return [...gateway.updateTasks(), ...(manualTools?.activity() ?? []),
          ...(task && ["running", "queued"].includes(task.state) ? ["Synthetic " + task.task_id] : [])];
      },
      confirm: async tasks => {
        const options = {type: "warning" as const, title: "重启并更新 LXE Agent",
          message: tasks.length ? `将停止 ${tasks.length} 项运行中或排队的任务，然后安装更新。` : "将关闭 LXE Agent 并安装已下载的更新。",
          detail: tasks.length ? "将清空等待执行的任务，并关闭应用内终端。已停止的任务不会自动重放。" : "应用将在安装完成后重新启动。",
          buttons: ["稍后", tasks.length ? "停止任务并更新" : "重启更新"], defaultId: 0, cancelId: 0};
        return (await (window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options))).response === 1;
      },
      fence: () => {
        const releaseGateway = gateway.beginUpdate();
        const releaseTools = manualTools?.beginUpdate();
        updateShutdown = true;
        return () => { updateShutdown = false; releaseGateway(); releaseTools?.(); };
      },
      settle: async () => { await gateway.settleUpdateAdmissions(); await manualTools?.settleUpdateAdmissions(); },
    }),
    cleanup: async () => {
      gatewayStopStarted = false;
      await gateway.cancelUpdateTasks();
      await cloud.stop();
      await syntheticPerformer.stop();
      await manualTools?.closeSession();
      gatewayStopStarted = true;
      await gateway.stop(true);
      await authBrowserHost.stop(true);
    },
    recover: async () => {
      await authBrowserHost.start();
      if (gatewayStopStarted) await gateway.recoverAfterUpdate();
      gatewayStopStarted = false;
      cloud.start();
    },
  });
  activeUpdates = updates;
  updates.start();
  let captionMenuOpen = false;
  const ipcApplication: DesktopIpcApplication = {
    showTitlebarMenu: async request => {
      const owner = window;
      if (desktopPlatform !== "win32" || !owner || owner.isDestroyed()) throw new Error("Windows titlebar menus are unavailable");
      if (captionMenuOpen) return null;
      const zoom = owner.webContents.getZoomFactor();
      const [width = 0, height = 0] = owner.getContentSize();
      const x = Math.round(request.x * zoom), y = Math.round(request.y * zoom);
      if (x > width || y > height) throw new Error("Titlebar menu anchor is outside the window");
      captionMenuOpen = true;
      try {
        return await new Promise<DesktopTitlebarAction>(resolve => {
          let selected: DesktopTitlebarAction = null;
          const finish = () => { owner.removeListener("closed", finish); resolve(selected); };
          owner.once("closed", finish);
          Menu.buildFromTemplate(titlebarMenuTemplate(request, {
            select: action => { selected = action; },
            canCheckUpdates: !["unsupported", "checking", "downloading", "verifying", "installing"].includes(updates.state().phase),
            edit: key => {
              if (owner.isDestroyed()) return;
              owner.webContents.focus();
              sendEditingShortcut(event => owner.webContents.sendInputEvent(event), key);
            },
            quit: () => { void shutdownApplication(); },
          })).popup({ window: owner, x, y, callback: finish });
        });
      } finally { captionMenuOpen = false; }
    },
    getUpdateState: () => updates.state(),
    checkForUpdate: () => updates.check(),
    downloadUpdate: target => updates.download(target),
    installUpdate: target => updates.install(target),
    // The renderer paints its own surface but not the frame around it. macOS
    // draws its controls from the system appearance and needs nothing; Windows
    // holds whatever colour it was handed at construction, so the caption strip
    // has to be repainted here or it stays light behind a dark page.
    applyAppearance: (appearance) => {
      const palette = DESKTOP_TITLEBAR_COLOURS[appearance];
      if (!window || window.isDestroyed()) return;
      window.setBackgroundColor(palette.color);
      if (desktopPlatform === "darwin") return;
      window.setTitleBarOverlay({ ...(desktopPlatform === "win32" ? WINDOWS_TITLEBAR_COLOURS[appearance] : palette), height: DESKTOP_TITLEBAR_HEIGHT });
    },
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
    getUsageBalance: () => usageBalance.getBalance(),
    saveSetup: async (input: DesktopSetupInput): Promise<DesktopSetupState> => {
      const previousEnvironment = config.environment();
      const previousSetup = config.state();
      const wasComplete = previousSetup.complete;
      const state = config.save(input);
      logging.configure();
      const nextEnvironment = config.environment();
      const runtimeConfigurationChanged = JSON.stringify(previousEnvironment) !== JSON.stringify(nextEnvironment);
      if (!wasComplete || runtimeConfigurationChanged) await gateway.restart();
      else if (state.workspace_root !== previousSetup.workspace_root) {
        await gateway.dashboardCall({ operation: "workspaces.register", input: { directory: state.workspace_root } });
      }
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
    prepareCloudDependencies: () => cloud.prepareDependencies(),
    getCloudState: () => cloud.state(),
    clearCloudModelCache: () => cloud.clearModelCache(),
    refreshCloudContext: () => cloud.check(),
    confirmCloudDevice: () => cloud.confirmDevice(),
    retryCloudConnection: () => cloud.retry(),
    openCloudDestination: async (destination: DesktopCloudDestination): Promise<void> => {
      const state = cloud.state();
      const dataServerUrl = state.device_context?.server_url ?? "";
      if (destination === "admin_dashboard") {
        await shell.openExternal(await cloud.adminDashboardUrl());
        return;
      }
      if (destination === "erp_dashboard") {
        await shell.openExternal(await cloud.erpDashboardUrl());
        return;
      }
      await shell.openExternal(resolveCloudDestinationUrl({
        configured: Boolean(state.device_context?.device),
        connection: state.native_access?.status === "connected" ? "connected" : "offline",
        dataServerUrl,
        destination,
        desktopFeatures: state.desktop_features,
      }));
    },
    logsDirectory: join(paths.dataRoot, "logs"),
    registerSyntheticPerformerSources: (kind, selectedPaths) =>
      syntheticPerformer.registerSources(kind, selectedPaths),
    registerSyntheticPerformerOutput: (path) => syntheticPerformer.registerOutput(path),
    startSyntheticPerformerTask: (input) => {
      if (updateShutdown) throw new Error("正在准备更新，暂时不能启动任务");
      return syntheticPerformer.start(input);
    },
    getSyntheticPerformerTask: () => syntheticPerformer.current(),
    cancelSyntheticPerformerTask: (taskId) => syntheticPerformer.cancel(taskId),
    syntheticPerformerOutputPath: (taskId) => syntheticPerformer.outputPath(taskId),
    listInputAssets: () => inputAssets.list(),
    inputAssetSlotDirectory: (slot) => inputAssets.directoryFor(slot),
    installVietnamSkuMap: (sourcePath, expectedRevision) => inputAssets.installVietnamSkuMap(sourcePath, expectedRevision),
    rollbackVietnamSkuMap: expectedRevision => inputAssets.rollbackVietnamSkuMap(expectedRevision),
    registerConversationFiles: (selectedPaths) => conversationAttachments.register(selectedPaths),
    registerPastedConversationFiles: (input) => conversationAttachments.registerPaste(input),
    isTrustedFileSender: event => !!window && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame,
    fileCall: call => gateway.fileCall(call),
    fileRead: (handle, relativeImage) => gateway.fileRead(handle, relativeImage),
    fileReadText: (handle, range) => gateway.fileReadText(handle, range),
    previewDraftConversationFile: async (attachmentId, variant = "expanded") => {
      const [attachment] = conversationAttachments.resolve([attachmentId]);
      return { data_url: await attachmentThumbnail(attachment!.path, variant === "thumbnail" ? 320 : 1600) };
    },
    discardConversationFiles: (attachmentIds) => conversationAttachments.discard(attachmentIds),
  };
  removeIpcHandlers = registerDesktopIpc(ipcApplication);
  manualTools = new ManualToolsService(() => window, dirname(fileURLToPath(import.meta.url)), id => gateway.resolveWorkspaceDirectory(id));
  manualTools.register();
  registerHtmlPreviewProtocol(session.defaultSession, token => gateway.htmlPreviewDocument(token));

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
          "Content-Security-Policy": [DASHBOARD_CSP],
        },
      });
    });
  }

  await cloud.start();
  try {
    await gateway.start();
  } catch (error) {
    logger.error("desktop_gateway_start_failed", { error });
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
  trackFilePreviewLifecycle(window.webContents, () => gateway.releaseFilePreviews());
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
  window.on("hide", () => manualTools?.browsers.hide());
  window.webContents.on("did-start-navigation", (_event, _url, _inPlace, main) => { if (main) manualTools?.browsers.hide(); });
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
  app.whenReady().then(async () => {
    if (needsDataBootstrap) {
      const completed = await bootstrapUserData(desktopPaths, dataIdentity.lxeDataAppId ?? "com.lxe.agent", validateCredentialCopy, async sources => {
        const result = await dialog.showMessageBox({type: "question", title: "选择旧数据", message: "发现多份 LXE Agent 数据，请选择要迁移的一份。原数据将保留。",
          buttons: [...sources, "取消"], cancelId: sources.length, noLink: true});
        return sources[result.response];
      });
      shutdownComplete = true;
      releaseDataLock?.(); releaseDataLock = undefined;
      if (completed) app.relaunch();
      app.exit(0);
      return;
    }
    app.setAppUserModelId(dataIdentity.lxeDataAppId ?? "com.lxe.agent");
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
}
