import { mkdirSync } from "node:fs";
import { dialog, ipcMain, shell } from "electron";
import type {
  DesktopConfigImportApplyResult,
  DesktopConfigImportPreview,
  DashboardTransportRequest,
  DesktopHealth,
  DesktopSetupInput,
  DesktopSetupState,
} from "@lxe/desktop-protocol";
import type { JsonValue } from "@lxe/protocol";
import { IPC_CHANNELS } from "../ipc-channels";
import { validateConfigImportId, validateDashboardRequest, validateSetupInput } from "./ipc-validation";

export interface DesktopIpcApplication {
  dashboardRequest(request: DashboardTransportRequest): Promise<JsonValue>;
  getHealth(): DesktopHealth;
  restartAgent(): Promise<DesktopHealth>;
  getSetupState(): DesktopSetupState;
  saveSetup(input: DesktopSetupInput): Promise<DesktopSetupState>;
  previewConfigImport(filePath: string): DesktopConfigImportPreview;
  applyConfigImport(importId: string): Promise<DesktopConfigImportApplyResult>;
  discardConfigImport(importId: string): void;
  logsDirectory: string;
}

export function registerDesktopIpc(application: DesktopIpcApplication): () => void {
  ipcMain.handle(IPC_CHANNELS.dashboardRequest, (_event, request: unknown) =>
    application.dashboardRequest(validateDashboardRequest(request)));
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
  ipcMain.handle(IPC_CHANNELS.selectConfigImport, async () => {
    const selection = await dialog.showOpenDialog({
      title: "选择 LXE Agent .env 配置文件",
      buttonLabel: "预览导入",
      properties: ["openFile", "showHiddenFiles"],
    });
    const filePath = selection.canceled ? undefined : selection.filePaths[0];
    return filePath ? application.previewConfigImport(filePath) : null;
  });
  ipcMain.handle(IPC_CHANNELS.applyConfigImport, (_event, importId: unknown) =>
    application.applyConfigImport(validateConfigImportId(importId)));
  ipcMain.handle(IPC_CHANNELS.discardConfigImport, (_event, importId: unknown) =>
    application.discardConfigImport(validateConfigImportId(importId)));
  ipcMain.handle(IPC_CHANNELS.openLogsDirectory, async () => {
    mkdirSync(application.logsDirectory, { recursive: true });
    const error = await shell.openPath(application.logsDirectory);
    if (error) throw new Error(error);
  });
  ipcMain.handle(IPC_CHANNELS.getHealth, () => application.getHealth());
  ipcMain.handle(IPC_CHANNELS.restartAgent, () => application.restartAgent());
  ipcMain.handle(IPC_CHANNELS.getSetupState, () => application.getSetupState());
  ipcMain.handle(IPC_CHANNELS.saveSetup, (_event, input: unknown) => application.saveSetup(validateSetupInput(input)));
  return () => {
    for (const channel of Object.values(IPC_CHANNELS)) {
      if (channel !== IPC_CHANNELS.statusChanged && channel !== IPC_CHANNELS.dashboardInvalidated) {
        ipcMain.removeHandler(channel);
      }
    }
  };
}
