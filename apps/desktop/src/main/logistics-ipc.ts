import type { IpcMainInvokeEvent } from "electron";
import type { DesktopIpcApplication } from "./ipc";
import { IPC_CHANNELS } from "../ipc-channels";
import { validateLogisticsProfileInput, validateLogisticsProfileId, validateLogisticsRevision } from "./ipc-validation";

type Application = Pick<DesktopIpcApplication, "isTrustedFileSender" | "getLogisticsSettings" | "refreshLogisticsStores" | "saveLogisticsProfile" | "deleteLogisticsProfile">;
interface Port { handle(channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown): unknown; }
export function registerLogisticsIpc(ipc: Port, application: Application): void {
  const trusted = (event: IpcMainInvokeEvent): void => {
    if (!application.isTrustedFileSender(event)) throw new Error("Logistics settings are only available to the desktop main frame");
  };
  ipc.handle(IPC_CHANNELS.getLogisticsSettings, event => { trusted(event); return application.getLogisticsSettings(); });
  ipc.handle(IPC_CHANNELS.refreshLogisticsStores, event => { trusted(event); return application.refreshLogisticsStores(); });
  ipc.handle(IPC_CHANNELS.saveLogisticsProfile, (event, input, revision) => {
    trusted(event);
    return application.saveLogisticsProfile(validateLogisticsProfileInput(input), validateLogisticsRevision(revision));
  });
  ipc.handle(IPC_CHANNELS.deleteLogisticsProfile, (event, id, revision) => {
    trusted(event);
    return application.deleteLogisticsProfile(validateLogisticsProfileId(id), validateLogisticsRevision(revision));
  });
}
