import { mkdirSync } from "node:fs";
import { dialog, ipcMain, shell } from "electron";
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
  DesktopInputAttachmentPayload,
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
import {
  validateCloudActivationInput,
  validateCloudDestination,
  validateDashboardRpcCall,
  validateLocalModelCredentialInput,
  validateModelProvider,
  validateSetupInput,
  validateSyntheticPerformerId,
  validateSyntheticPerformerSourceKind,
  validateSyntheticPerformerTaskInput,
} from "./ipc-validation";

export interface DesktopIpcApplication {
  dashboardCall<O extends DashboardRpcOperation>(call: DashboardRpcCall<O>): Promise<DashboardRpcResult<O>>;
  getHealth(): DesktopHealth;
  restartAgent(): Promise<DesktopHealth>;
  getSetupState(): DesktopSetupState;
  saveSetup(input: DesktopSetupInput): Promise<DesktopSetupState>;
  saveLocalModelCredential(input: DesktopLocalModelCredentialInput): Promise<DesktopSetupState>;
  deleteLocalModelCredential(provider: DesktopModelProvider): Promise<DesktopSetupState>;
  previewCloudEnrollment(filePath: string): DesktopCloudEnrollmentSelection;
  activateCloudEnrollment(input: DesktopCloudActivationInput): Promise<DesktopCloudState>;
  getCloudState(): DesktopCloudState;
  retryCloudConnection(): Promise<DesktopCloudState>;
  openCloudDestination(destination: DesktopCloudDestination): Promise<void>;
  logsDirectory: string;
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
  registerConversationFiles(paths: string[]): DesktopInputAttachmentPayload[];
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
  ipcMain.handle(IPC_CHANNELS.dashboardCall, (_event, call: unknown) =>
    application.dashboardCall(validateDashboardRpcCall(call)));
  ipcMain.handle(IPC_CHANNELS.selectWorkspace, async () => {
    const selection = await dialog.showOpenDialog({
      title: "选择 LXE Agent 工作区",
      properties: ["openDirectory", "createDirectory"],
    });
    return selection.canceled ? null : selection.filePaths[0] ?? null;
  });
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
  ipcMain.handle(IPC_CHANNELS.getCloudState, () => application.getCloudState());
  ipcMain.handle(IPC_CHANNELS.retryCloudConnection, () => application.retryCloudConnection());
  ipcMain.handle(IPC_CHANNELS.openCloudDestination, (_event, destination: unknown) =>
    application.openCloudDestination(validateCloudDestination(destination)));
  ipcMain.handle(IPC_CHANNELS.openLogsDirectory, async () => {
    mkdirSync(application.logsDirectory, { recursive: true });
    const error = await shell.openPath(application.logsDirectory);
    if (error) throw new Error(error);
  });
  ipcMain.handle(IPC_CHANNELS.getHealth, () => application.getHealth());
  ipcMain.handle(IPC_CHANNELS.restartAgent, () => application.restartAgent());
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
      filters: [{
        name: "支持的文件",
        extensions: [
          "pdf", "doc", "docx", "ppt", "pptx", "txt", "md",
          "xls", "xlsx", "xlsm", "csv", "tsv",
          "json", "jsonl", "xml", "yaml", "yml",
          "png", "jpg", "jpeg", "webp", "gif",
        ],
      }],
    });
    return selection.canceled ? [] : application.registerConversationFiles(selection.filePaths);
  });
  ipcMain.handle(IPC_CHANNELS.stageDroppedConversationFiles, (_event, paths: unknown) =>
    application.registerConversationFiles(stringArray(paths, "dropped file paths")));
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
  ipcMain.handle(IPC_CHANNELS.listInputAssets, () => application.listInputAssets());
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
