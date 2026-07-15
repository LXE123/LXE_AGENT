import { dialog, ipcMain } from "electron";
import type {
  DashboardTransportRequest,
  DesktopHealth,
  DesktopSetupInput,
  DesktopSetupState,
} from "@lxe/desktop-protocol";
import type { JsonValue } from "@lxe/protocol";
import { IPC_CHANNELS } from "../ipc-channels";
import { validateDashboardRequest, validateSetupInput } from "./ipc-validation";

export interface DesktopIpcApplication {
  dashboardRequest(request: DashboardTransportRequest): Promise<JsonValue>;
  getHealth(): DesktopHealth;
  restartAgent(): Promise<DesktopHealth>;
  getSetupState(): DesktopSetupState;
  saveSetup(input: DesktopSetupInput): Promise<DesktopSetupState>;
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
  ipcMain.handle(IPC_CHANNELS.getHealth, () => application.getHealth());
  ipcMain.handle(IPC_CHANNELS.restartAgent, () => application.restartAgent());
  ipcMain.handle(IPC_CHANNELS.getSetupState, () => application.getSetupState());
  ipcMain.handle(IPC_CHANNELS.saveSetup, (_event, input: unknown) => application.saveSetup(validateSetupInput(input)));
  return () => {
    for (const channel of Object.values(IPC_CHANNELS)) {
      if (channel !== IPC_CHANNELS.statusChanged) ipcMain.removeHandler(channel);
    }
  };
}
