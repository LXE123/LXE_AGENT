import type {
  DesktopCloudState,
  DesktopConversationEvent,
  DesktopDashboardInvalidation,
  DesktopHealth,
  DesktopPlatform,
  DesktopSyntheticPerformerTask,
  LxeDesktopBridge,
} from "@lxe/desktop-protocol";
import { IPC_CHANNELS } from "./ipc-channels";

type IpcListener = (event: unknown, ...arguments_: unknown[]) => void;

export interface IpcRendererPort {
  invoke<T>(channel: string, ...arguments_: unknown[]): Promise<T>;
  on(channel: string, listener: IpcListener): void;
  removeListener(channel: string, listener: IpcListener): void;
}

export interface DesktopFilePathPort {
  getPathForFile(file: File): string;
}

/** Construct the complete and intentionally narrow Renderer API whitelist. */
export function createDesktopBridge(
  ipc: IpcRendererPort,
  platform: DesktopPlatform,
  files?: DesktopFilePathPort,
): LxeDesktopBridge {
  return {
    dashboard: {
      call: (call) => ipc.invoke(IPC_CHANNELS.dashboardCall, call),
    },
    desktop: {
      platform,
      selectWorkspace: () => ipc.invoke(IPC_CHANNELS.selectWorkspace),
      selectZiniaoApp: () => ipc.invoke(IPC_CHANNELS.selectZiniaoApp),
      selectZiniaoWebDriverDirectory: () => ipc.invoke(IPC_CHANNELS.selectZiniaoWebDriverDirectory),
      selectConfigImport: () => ipc.invoke(IPC_CHANNELS.selectConfigImport),
      selectCloudEnrollment: () => ipc.invoke(IPC_CHANNELS.selectCloudEnrollment),
      activateCloudEnrollment: (input) => ipc.invoke(IPC_CHANNELS.activateCloudEnrollment, input),
      getCloudState: () => ipc.invoke(IPC_CHANNELS.getCloudState),
      retryCloudConnection: () => ipc.invoke(IPC_CHANNELS.retryCloudConnection),
      applyConfigImport: (importId) => ipc.invoke(IPC_CHANNELS.applyConfigImport, importId),
      discardConfigImport: (importId) => ipc.invoke(IPC_CHANNELS.discardConfigImport, importId),
      openLogsDirectory: () => ipc.invoke(IPC_CHANNELS.openLogsDirectory),
      getHealth: () => ipc.invoke(IPC_CHANNELS.getHealth),
      restartAgent: () => ipc.invoke(IPC_CHANNELS.restartAgent),
      getSetupState: () => ipc.invoke(IPC_CHANNELS.getSetupState),
      saveSetup: (input) => ipc.invoke(IPC_CHANNELS.saveSetup, input),
      selectSyntheticPerformerSources: (kind) =>
        ipc.invoke(IPC_CHANNELS.selectSyntheticPerformerSources, kind),
      selectSyntheticPerformerOutput: () =>
        ipc.invoke(IPC_CHANNELS.selectSyntheticPerformerOutput),
      selectConversationFiles: () =>
        ipc.invoke(IPC_CHANNELS.selectConversationFiles),
      stageDroppedConversationFiles: (droppedFiles) => {
        if (!files) return Promise.reject(new Error("Local file paths are unavailable"));
        return ipc.invoke(
          IPC_CHANNELS.stageDroppedConversationFiles,
          droppedFiles.map((file) => files.getPathForFile(file)),
        );
      },
      discardConversationFiles: (attachmentIds) =>
        ipc.invoke(IPC_CHANNELS.discardConversationFiles, attachmentIds),
      startSyntheticPerformerTask: (input) =>
        ipc.invoke(IPC_CHANNELS.startSyntheticPerformerTask, input),
      getSyntheticPerformerTask: () =>
        ipc.invoke(IPC_CHANNELS.getSyntheticPerformerTask),
      cancelSyntheticPerformerTask: (taskId) =>
        ipc.invoke(IPC_CHANNELS.cancelSyntheticPerformerTask, taskId),
      openSyntheticPerformerOutput: (taskId) =>
        ipc.invoke(IPC_CHANNELS.openSyntheticPerformerOutput, taskId),
      onCloudStateChanged: (listener) => {
        const handler: IpcListener = (_event, state) => listener(state as DesktopCloudState);
        ipc.on(IPC_CHANNELS.cloudStateChanged, handler);
        return () => ipc.removeListener(IPC_CHANNELS.cloudStateChanged, handler);
      },
      onConversationEvent: (listener) => {
        const handler: IpcListener = (_event, conversationEvent) =>
          listener(conversationEvent as DesktopConversationEvent);
        ipc.on(IPC_CHANNELS.conversationEvent, handler);
        return () => ipc.removeListener(IPC_CHANNELS.conversationEvent, handler);
      },
      onDashboardInvalidated: (listener) => {
        const handler: IpcListener = (_event, invalidation) =>
          listener(invalidation as DesktopDashboardInvalidation);
        ipc.on(IPC_CHANNELS.dashboardInvalidated, handler);
        return () => ipc.removeListener(IPC_CHANNELS.dashboardInvalidated, handler);
      },
      onStatusChanged: (listener) => {
        const handler: IpcListener = (_event, health) => listener(health as DesktopHealth);
        ipc.on(IPC_CHANNELS.statusChanged, handler);
        return () => ipc.removeListener(IPC_CHANNELS.statusChanged, handler);
      },
      onSyntheticPerformerTaskChanged: (listener) => {
        const handler: IpcListener = (_event, task) =>
          listener(task as DesktopSyntheticPerformerTask);
        ipc.on(IPC_CHANNELS.syntheticPerformerTaskChanged, handler);
        return () => ipc.removeListener(IPC_CHANNELS.syntheticPerformerTaskChanged, handler);
      },
    },
  };
}
