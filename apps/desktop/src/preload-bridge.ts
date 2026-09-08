import type {
  DesktopCloudState,
  DesktopConversationEvent,
  DesktopConversationStreamEvent,
  DesktopDashboardInvalidation,
  DesktopHealth,
  DesktopDraftAttachmentPayload,
  DesktopPlatform,
  DesktopSyntheticPerformerTask,
  LxeDesktopBridge,
} from "@lxe/desktop-protocol";
import { IPC_CHANNELS } from "./ipc-channels";
import { prepareConversationPaste } from "./conversation-paste";

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
      selectCloudEnrollment: () => ipc.invoke(IPC_CHANNELS.selectCloudEnrollment),
      activateCloudEnrollment: (input) => ipc.invoke(IPC_CHANNELS.activateCloudEnrollment, input),
      prepareCloudDependencies: () => ipc.invoke(IPC_CHANNELS.prepareCloudDependencies),
      getCloudState: () => ipc.invoke(IPC_CHANNELS.getCloudState),
      retryCloudConnection: () => ipc.invoke(IPC_CHANNELS.retryCloudConnection),
      openCloudDestination: (destination) => ipc.invoke(IPC_CHANNELS.openCloudDestination, destination),
      openLogsDirectory: () => ipc.invoke(IPC_CHANNELS.openLogsDirectory),
      applyAppearance: (appearance) => ipc.invoke(IPC_CHANNELS.applyAppearance, appearance),
      getHealth: () => ipc.invoke(IPC_CHANNELS.getHealth),
      restartAgent: () => ipc.invoke(IPC_CHANNELS.restartAgent),
      getSetupState: () => ipc.invoke(IPC_CHANNELS.getSetupState),
      saveSetup: (input) => ipc.invoke(IPC_CHANNELS.saveSetup, input),
      saveLocalModelCredential: (input) => ipc.invoke(IPC_CHANNELS.saveLocalModelCredential, input),
      deleteLocalModelCredential: (provider) => ipc.invoke(IPC_CHANNELS.deleteLocalModelCredential, provider),
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
      stagePastedConversationFiles: async (pastedFiles) => {
        if (!files) throw new Error("Local file paths are unavailable");
        const nativeFiles = await ipc.invoke<DesktopDraftAttachmentPayload[]>(IPC_CHANNELS.readClipboardConversationFiles);
        if (nativeFiles.length) return nativeFiles;
        if (!pastedFiles.length) return [];
        const input = await prepareConversationPaste(pastedFiles, (file) => files.getPathForFile(file));
        return ipc.invoke(IPC_CHANNELS.stagePastedConversationFiles, input);
      },
      startSyntheticPerformerTask: (input) =>
        ipc.invoke(IPC_CHANNELS.startSyntheticPerformerTask, input),
      getSyntheticPerformerTask: () =>
        ipc.invoke(IPC_CHANNELS.getSyntheticPerformerTask),
      cancelSyntheticPerformerTask: (taskId) =>
        ipc.invoke(IPC_CHANNELS.cancelSyntheticPerformerTask, taskId),
      openSyntheticPerformerOutput: (taskId) =>
        ipc.invoke(IPC_CHANNELS.openSyntheticPerformerOutput, taskId),
      listInputAssets: () => ipc.invoke(IPC_CHANNELS.listInputAssets),
      revealInputAssetSlot: (slot) => ipc.invoke(IPC_CHANNELS.revealInputAssetSlot, slot),
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
      onSessionStatus: (listener) => {
        const handler: IpcListener = (_event,snapshot) => listener(snapshot as import("@lxe/desktop-protocol").SessionStatusSnapshot);
        ipc.on(IPC_CHANNELS.sessionStatus,handler);
        return () => ipc.removeListener(IPC_CHANNELS.sessionStatus,handler);
      },
      onConversationStreamEvent: (listener) => {
        const handler: IpcListener = (_event, conversationEvent) =>
          listener(conversationEvent as DesktopConversationStreamEvent);
        ipc.on(IPC_CHANNELS.conversationStreamEvent, handler);
        return () => ipc.removeListener(IPC_CHANNELS.conversationStreamEvent, handler);
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
