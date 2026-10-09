import { validateTitlebarMenu } from "./titlebar-menu";
import { fileResult } from "./file-preview/errors";
import { mkdirSync } from "node:fs";
import { app, dialog, ipcMain, shell } from "electron";
import type {
  DashboardRpcCall,
  DashboardRpcOperation,
  DashboardRpcResult,
  DesktopCloudActivationInput,
  DesktopCloudDestination,
  DesktopCloudEnrollmentSelection,
  DesktopCloudState,
  DesktopHealth,
  DesktopInputAssetSlot,
  DesktopVietnamSkuMapMutation,
  DesktopInputAttachmentPayload,
  DesktopDraftAttachmentPayload,
  DesktopLocalModelCredentialInput,
  DesktopModelProvider,
  DesktopSetupInput,
  DesktopSetupState,
  DesktopSyntheticPerformerOutputSelection,
  DesktopSyntheticPerformerSourceKind,
  DesktopSyntheticPerformerSourceSelection,
  DesktopSyntheticPerformerTask,
  DesktopSyntheticPerformerTaskInput,
} from "@lxe/desktop-protocol";
import { IPC_CHANNELS } from "../ipc-channels";
import { workspaceDirectory } from "./workspace-directory";
import { WorkspaceApplications } from "./workspace-apps/service";
import { bundleIconDataUrl } from "./workspace-apps/icons";
import { readClipboardFilePaths } from "./clipboard-files";
import { createVietnamSkuMapActions } from "./vietnam-sku-map-actions";
import {
  validateDraftImagePreviewVariant,
  validateCloudActivationInput,
  validateCloudDestination,
  validateDashboardRpcCall,
  validateDesktopAppearance,
  validateLocalModelCredentialInput,
  validateModelProvider,
  validateSetupInput,
  validateSyntheticPerformerId,
  validateSyntheticPerformerSourceKind,
  validateSyntheticPerformerTaskInput,
  validateVietnamSkuMapRevision,
} from "./ipc-validation";

export interface DesktopIpcApplication {
  showTitlebarMenu?(request: import("@lxe/desktop-protocol").DesktopTitlebarMenuRequest): Promise<import("@lxe/desktop-protocol").DesktopTitlebarAction>;
  isTrustedFileSender(event: import("electron").IpcMainInvokeEvent): boolean;
  fileCall?<K extends keyof import("@lxe/desktop-protocol").DesktopFileOperations>(call: import("@lxe/desktop-protocol").DesktopFileCall<K>): Promise<import("@lxe/desktop-protocol").DesktopFileOperations[K]["result"]>;
  fileRead?(handle: string, relativeImage?: string): Promise<Uint8Array>;
  fileReadText?(handle: string, range?: import("@lxe/desktop-protocol").TextPageRequest): Promise<import("@lxe/desktop-protocol").PreviewTextPage>;
  getUpdateState?(): import("@lxe/desktop-protocol").DesktopUpdateState;
  checkForUpdate?(): Promise<import("@lxe/desktop-protocol").DesktopUpdateState>;
  downloadUpdate?(target: import("@lxe/desktop-protocol").DesktopUpdateIdentity): Promise<import("@lxe/desktop-protocol").DesktopUpdateState>;
  installUpdate?(target: import("@lxe/desktop-protocol").DesktopUpdateIdentity): Promise<import("@lxe/desktop-protocol").DesktopUpdateState>;
  dashboardCall<O extends DashboardRpcOperation>(call: DashboardRpcCall<O>): Promise<DashboardRpcResult<O>>;
  getHealth(): DesktopHealth;
  restartAgent(): Promise<DesktopHealth>;
  getSetupState(): DesktopSetupState;
  getUsageBalance(): Promise<import("@lxe/desktop-protocol").DesktopUsageBalance>;
  saveSetup(input: DesktopSetupInput): Promise<DesktopSetupState>;
  saveLocalModelCredential(input: DesktopLocalModelCredentialInput): Promise<DesktopSetupState>;
  deleteLocalModelCredential(provider: DesktopModelProvider): Promise<DesktopSetupState>;
  previewCloudEnrollment(filePath: string): DesktopCloudEnrollmentSelection;
  activateCloudEnrollment(input: DesktopCloudActivationInput): Promise<DesktopCloudState>;
  prepareCloudDependencies(): Promise<DesktopCloudState>;
  getCloudState(): DesktopCloudState;
  clearCloudModelCache(): Promise<DesktopCloudState>;
  refreshCloudContext(): Promise<DesktopCloudState>;
  confirmCloudDevice(): Promise<DesktopCloudState>;
  retryCloudConnection(): Promise<DesktopCloudState>;
  openCloudDestination(destination: DesktopCloudDestination): Promise<void>;
  logsDirectory: string;
  applyAppearance(appearance: "light" | "dark"): void;
  registerSyntheticPerformerSources(
    kind: DesktopSyntheticPerformerSourceKind,
    paths: string[],
  ): DesktopSyntheticPerformerSourceSelection;
  registerSyntheticPerformerOutput(path: string): DesktopSyntheticPerformerOutputSelection;
  startSyntheticPerformerTask(input: DesktopSyntheticPerformerTaskInput): DesktopSyntheticPerformerTask;
  getSyntheticPerformerTask(): DesktopSyntheticPerformerTask | null;
  cancelSyntheticPerformerTask(taskId: string): Promise<DesktopSyntheticPerformerTask | null>;
  syntheticPerformerOutputPath(taskId: string): string;
  listInputAssets(): Promise<DesktopInputAssetSlot[]>;
  inputAssetSlotDirectory(slot: string): Promise<string>;
  installVietnamSkuMap(sourcePath: string, expectedRevision: string | null): Promise<DesktopVietnamSkuMapMutation>;
  rollbackVietnamSkuMap(expectedRevision: string): Promise<DesktopVietnamSkuMapMutation>;
  registerConversationFiles(paths: string[]): DesktopInputAttachmentPayload[];
  registerPastedConversationFiles(input: unknown): DesktopDraftAttachmentPayload[];
  previewDraftConversationFile(attachmentId: string, variant?: "thumbnail" | "expanded"): Promise<{ data_url: string }>;
  discardConversationFiles(attachmentIds: string[]): void;
}

const inputAssetSlotId = (value: unknown): string => {
  const slot = typeof value === "string" ? value.trim() : "";
  // Slot ids come from the catalog registry; anything else must not reach the shell.
  if (!/^[a-z][a-z0-9_]*$/u.test(slot)) throw new Error("invalid input asset slot");
  return slot;
};

const stringArray = (value: unknown, label: string): string[] => {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
  return value as string[];
};

export function registerDesktopIpc(application: DesktopIpcApplication): () => void {
  const workspaceApps = new WorkspaceApplications({ openPath: path => shell.openPath(path), icon: path => process.platform === "darwin" ? bundleIconDataUrl(path) : app.getFileIcon(path, { size: "normal" }).then(image => image.toDataURL()) });
  const trustedWorkspaceSender = (event: Electron.IpcMainInvokeEvent) => { if (!application.isTrustedFileSender(event)) throw new Error("Workspace applications are only available to the desktop main frame"); };
  ipcMain.handle(IPC_CHANNELS.fileCall, (event, call) => fileResult(typeof call?.operation === "string" ? call.operation : "call", () => {
    if (!application.isTrustedFileSender(event)) throw new Error("File previews are only available to the desktop main frame");
    if (call?.operation === "focus-preview") {
      if (typeof call.input?.focused !== "boolean") throw new Error("Invalid preview focus state");
      event.sender.setIgnoreMenuShortcuts(call.input.focused);
      return;
    }
    if (!application.fileCall) throw new Error("File previews are unavailable");
    return application.fileCall(call);
  }));
  ipcMain.handle(IPC_CHANNELS.fileReadText, (event, handle, range) => fileResult("read_text", () => {
    if (!application.isTrustedFileSender(event)) throw new Error("File previews are only available to the desktop main frame");
    if (!application.fileReadText) throw new Error("File previews are unavailable");
    return application.fileReadText(handle, range);
  }));
  ipcMain.handle(IPC_CHANNELS.fileRead, (event, handle, relativeImage) => fileResult(relativeImage === undefined ? "read" : "read_image", () => {
    if (!application.isTrustedFileSender(event)) throw new Error("File previews are only available to the desktop main frame");
    if (!application.fileRead) throw new Error("File previews are unavailable");
    return application.fileRead(handle, relativeImage);
  }));
  ipcMain.handle(IPC_CHANNELS.showTitlebarMenu, (event, input: unknown) => {
    if (!application.isTrustedFileSender(event)) throw new Error("Titlebar menus are only available to the desktop main frame");
    if (!application.showTitlebarMenu) throw new Error("Windows titlebar menus are unavailable");
    return application.showTitlebarMenu(validateTitlebarMenu(input));
  });
  ipcMain.handle(IPC_CHANNELS.getUpdateState, () => application.getUpdateState?.() ?? {phase:"unsupported"});
  ipcMain.handle(IPC_CHANNELS.checkForUpdate, () => application.checkForUpdate?.() ?? {phase:"unsupported"});
  const updateTarget = (event: Electron.IpcMainInvokeEvent, value: unknown) => {
    if (!application.isTrustedFileSender(event)) throw new Error("Updates are only available to the desktop main frame");
    const target = value as {version?: unknown; build_id?: unknown} | null;
    if (!target || typeof target.version !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(target.version)
      || typeof target.build_id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(target.build_id)) throw new Error("Invalid update target");
    return {version:target.version,build_id:target.build_id};
  };
  ipcMain.handle(IPC_CHANNELS.downloadUpdate, (event, value:unknown) => application.downloadUpdate?.(updateTarget(event,value)) ?? {phase:"unsupported"});
  ipcMain.handle(IPC_CHANNELS.installUpdate, (event, value:unknown) => application.installUpdate?.(updateTarget(event,value)) ?? {phase:"unsupported"});
  ipcMain.handle(IPC_CHANNELS.dashboardCall, (_event, call: unknown) =>
    application.dashboardCall(validateDashboardRpcCall(call)));
  ipcMain.handle(IPC_CHANNELS.selectWorkspace, async () => {
    const selection = await dialog.showOpenDialog({
      title: "选择 LXE Agent 工作区",
      properties: ["openDirectory", "createDirectory"],
    });
    return selection.canceled || !selection.filePaths[0] ? null : workspaceDirectory(selection.filePaths[0]);
  });
  ipcMain.handle(IPC_CHANNELS.getWorkspaceApplications, (event, input: unknown) => { trustedWorkspaceSender(event); return workspaceApps.list(input); });
  ipcMain.handle(IPC_CHANNELS.openWorkspace, (event, directory: unknown, applicationId: unknown) => { trustedWorkspaceSender(event); return workspaceApps.open(directory, applicationId); });
  ipcMain.handle(IPC_CHANNELS.selectZiniaoApp, async () => {
    const selection = await dialog.showOpenDialog({
      title: "选择紫鸟 APP",
      properties: process.platform === "darwin" ? ["openFile", "openDirectory"] : ["openFile"],
      ...(process.platform === "win32" ? { filters: [{ name: "应用程序", extensions: ["exe"] }] } : {}),
    });
    return selection.canceled ? null : selection.filePaths[0] ?? null;
  });
  ipcMain.handle(IPC_CHANNELS.selectZiniaoWebDriverDirectory, async () => {
    const selection = await dialog.showOpenDialog({
      title: "选择紫鸟浏览器驱动安装目录",
      properties: ["openDirectory", "createDirectory"],
    });
    return selection.canceled ? null : selection.filePaths[0] ?? null;
  });
  ipcMain.handle(IPC_CHANNELS.selectCloudEnrollment, async () => {
    const selection = await dialog.showOpenDialog({
      title: "选择公司云端设备文件",
      buttonLabel: "选择",
      properties: ["openFile"],
      filters: [{ name: "LXE 设备文件", extensions: ["lxe-enroll"] }],
    });
    const filePath = selection.canceled ? undefined : selection.filePaths[0];
    return filePath ? application.previewCloudEnrollment(filePath) : null;
  });
  ipcMain.handle(IPC_CHANNELS.activateCloudEnrollment, (_event, input: unknown) =>
    application.activateCloudEnrollment(validateCloudActivationInput(input)));
  ipcMain.handle(IPC_CHANNELS.prepareCloudDependencies, () => application.prepareCloudDependencies());
  ipcMain.handle(IPC_CHANNELS.getCloudState, () => application.getCloudState());
  ipcMain.handle(IPC_CHANNELS.clearCloudModelCache, () => application.clearCloudModelCache());
  ipcMain.handle(IPC_CHANNELS.refreshCloudContext, () => application.refreshCloudContext());
  ipcMain.handle(IPC_CHANNELS.confirmCloudDevice, () => application.confirmCloudDevice());
  ipcMain.handle(IPC_CHANNELS.retryCloudConnection, () => application.retryCloudConnection());
  ipcMain.handle(IPC_CHANNELS.openCloudDestination, (_event, destination: unknown) =>
    application.openCloudDestination(validateCloudDestination(destination)));
  ipcMain.handle(IPC_CHANNELS.applyAppearance, (_event, appearance: unknown) =>
    application.applyAppearance(validateDesktopAppearance(appearance)));
  ipcMain.handle(IPC_CHANNELS.openLogsDirectory, async () => {
    mkdirSync(application.logsDirectory, { recursive: true });
    const error = await shell.openPath(application.logsDirectory);
    if (error) throw new Error(error);
  });
  ipcMain.handle(IPC_CHANNELS.getHealth, () => application.getHealth());
  ipcMain.handle(IPC_CHANNELS.restartAgent, () => application.restartAgent());
  ipcMain.handle(IPC_CHANNELS.getUsageBalance, () => application.getUsageBalance());
  ipcMain.handle(IPC_CHANNELS.getSetupState, () => application.getSetupState());
  ipcMain.handle(IPC_CHANNELS.saveSetup, (_event, input: unknown) => application.saveSetup(validateSetupInput(input)));
  ipcMain.handle(IPC_CHANNELS.saveLocalModelCredential, (_event, input: unknown) =>
    application.saveLocalModelCredential(validateLocalModelCredentialInput(input)));
  ipcMain.handle(IPC_CHANNELS.deleteLocalModelCredential, (_event, provider: unknown) =>
    application.deleteLocalModelCredential(validateModelProvider(provider)));
  ipcMain.handle(IPC_CHANNELS.selectSyntheticPerformerSources, async (_event, rawKind: unknown) => {
    const kind = validateSyntheticPerformerSourceKind(rawKind);
    const selection = await dialog.showOpenDialog({
      title: kind === "folder" ? "选择媒体文件夹" : "选择图片或视频",
      buttonLabel: "选择",
      properties: kind === "folder" ? ["openDirectory"] : ["openFile", "multiSelections"],
      ...(kind === "files" ? {
        filters: [{ name: "图片和视频", extensions: ["jpg", "jpeg", "png", "mp4", "mov"] }],
      } : {}),
    });
    return selection.canceled
      ? null
      : application.registerSyntheticPerformerSources(kind, selection.filePaths);
  });
  ipcMain.handle(IPC_CHANNELS.selectSyntheticPerformerOutput, async () => {
    const selection = await dialog.showOpenDialog({
      title: "选择合规媒体输出目录",
      buttonLabel: "选择输出目录",
      properties: ["openDirectory", "createDirectory"],
    });
    const path = selection.canceled ? undefined : selection.filePaths[0];
    return path ? application.registerSyntheticPerformerOutput(path) : null;
  });
  ipcMain.handle(IPC_CHANNELS.selectConversationFiles, async () => {
    const selection = await dialog.showOpenDialog({
      title: "选择对话文件",
      buttonLabel: "添加",
      properties: ["openFile", "multiSelections"],
    });
    return selection.canceled ? [] : application.registerConversationFiles(selection.filePaths);
  });
  ipcMain.handle(IPC_CHANNELS.stageDroppedConversationFiles, (_event, paths: unknown) =>
    application.registerConversationFiles(stringArray(paths, "dropped file paths")));
  ipcMain.handle(IPC_CHANNELS.stagePastedConversationFiles, (_event, input: unknown) =>
    application.registerPastedConversationFiles(input));
  ipcMain.handle(IPC_CHANNELS.readClipboardConversationFiles, () =>
    application.registerConversationFiles(readClipboardFilePaths()));
  ipcMain.handle(IPC_CHANNELS.previewDraftConversationFile, (_event, attachmentId: unknown, variant: unknown) => {
    if (typeof attachmentId !== "string" || !attachmentId.trim()) throw new Error("Invalid attachment ID");
    return application.previewDraftConversationFile(attachmentId, validateDraftImagePreviewVariant(variant));
  });
  ipcMain.handle(IPC_CHANNELS.discardConversationFiles, (_event, attachmentIds: unknown) =>
    application.discardConversationFiles(stringArray(attachmentIds, "attachment IDs")));
  ipcMain.handle(IPC_CHANNELS.startSyntheticPerformerTask, (_event, input: unknown) =>
    application.startSyntheticPerformerTask(validateSyntheticPerformerTaskInput(input)));
  ipcMain.handle(IPC_CHANNELS.getSyntheticPerformerTask, () => application.getSyntheticPerformerTask());
  ipcMain.handle(IPC_CHANNELS.cancelSyntheticPerformerTask, (_event, taskId: unknown) =>
    application.cancelSyntheticPerformerTask(validateSyntheticPerformerId(taskId)));
  ipcMain.handle(IPC_CHANNELS.openSyntheticPerformerOutput, async (_event, taskId: unknown) => {
    const path = application.syntheticPerformerOutputPath(validateSyntheticPerformerId(taskId));
    const error = await shell.openPath(path);
    if (error) throw new Error(error);
  });
  const mapActions = createVietnamSkuMapActions({
    list: () => application.listInputAssets(),
    choose: () => dialog.showOpenDialog({
      title: "选择越南 SKU 参数表",
      properties: ["openFile"],
      filters: [{ name: "Excel 工作簿", extensions: ["xlsx"] }],
    }),
    install: (sourcePath, expectedRevision) => application.installVietnamSkuMap(sourcePath, expectedRevision),
    rollback: expectedRevision => application.rollbackVietnamSkuMap(expectedRevision),
  });
  ipcMain.handle(IPC_CHANNELS.listInputAssets, () => application.listInputAssets());
  ipcMain.handle(IPC_CHANNELS.uploadVietnamSkuMap, (event) => {
    if (!application.isTrustedFileSender(event)) throw new Error("Only the desktop main frame may manage input assets");
    return mapActions.upload();
  });
  ipcMain.handle(IPC_CHANNELS.rollbackVietnamSkuMap, (event, expectedRevision: unknown) => {
    if (!application.isTrustedFileSender(event)) throw new Error("Only the desktop main frame may manage input assets");
    return mapActions.rollback(validateVietnamSkuMapRevision(expectedRevision));
  });
  ipcMain.handle(IPC_CHANNELS.revealInputAssetSlot, async (_event, slot: unknown) => {
    const directory = await application.inputAssetSlotDirectory(inputAssetSlotId(slot));
    const error = await shell.openPath(directory);
    if (error) throw new Error(error);
  });
  return () => {
    for (const channel of Object.values(IPC_CHANNELS)) {
      if (channel !== IPC_CHANNELS.statusChanged
        && channel !== IPC_CHANNELS.cloudStateChanged
        && channel !== IPC_CHANNELS.conversationEvent
        && channel !== IPC_CHANNELS.dashboardInvalidated) {
        // Event-only channels do not have invoke handlers.
        if (channel === IPC_CHANNELS.syntheticPerformerTaskChanged) continue;
        ipcMain.removeHandler(channel);
      }
    }
  };
}
