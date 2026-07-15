import type {
  DesktopHealth,
  LxeDesktopBridge,
} from "@lxe/desktop-protocol";
import { IPC_CHANNELS } from "./ipc-channels";

type IpcListener = (event: unknown, ...arguments_: unknown[]) => void;

export interface IpcRendererPort {
  invoke<T>(channel: string, ...arguments_: unknown[]): Promise<T>;
  on(channel: string, listener: IpcListener): void;
  removeListener(channel: string, listener: IpcListener): void;
}

/** Construct the complete and intentionally narrow Renderer API whitelist. */
export function createDesktopBridge(ipc: IpcRendererPort): LxeDesktopBridge {
  return {
    dashboard: {
      request: (request) => ipc.invoke(IPC_CHANNELS.dashboardRequest, request),
    },
    desktop: {
      selectWorkspace: () => ipc.invoke(IPC_CHANNELS.selectWorkspace),
      getHealth: () => ipc.invoke(IPC_CHANNELS.getHealth),
      restartAgent: () => ipc.invoke(IPC_CHANNELS.restartAgent),
      getSetupState: () => ipc.invoke(IPC_CHANNELS.getSetupState),
      saveSetup: (input) => ipc.invoke(IPC_CHANNELS.saveSetup, input),
      onStatusChanged: (listener) => {
        const handler: IpcListener = (_event, health) => listener(health as DesktopHealth);
        ipc.on(IPC_CHANNELS.statusChanged, handler);
        return () => ipc.removeListener(IPC_CHANNELS.statusChanged, handler);
      },
    },
  };
}
