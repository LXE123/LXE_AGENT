import { describe, expect, test } from "bun:test";
import { IPC_CHANNELS } from "../src/ipc-channels";
import { createDesktopBridge, type IpcRendererPort } from "../src/preload-bridge";

describe("preload bridge", () => {
  test("exposes only the typed Dashboard and desktop whitelist", async () => {
    const invocations: Array<{ channel: string; arguments: unknown[] }> = [];
    const listeners = new Map<string, (event: unknown, ...arguments_: unknown[]) => void>();
    const ipc: IpcRendererPort = {
      invoke: async <T>(channel: string, ...arguments_: unknown[]): Promise<T> => {
        invocations.push({ channel, arguments: arguments_ });
        return {} as T;
      },
      on: (channel, listener) => { listeners.set(channel, listener); },
      removeListener: (channel, listener) => {
        if (listeners.get(channel) === listener) listeners.delete(channel);
      },
    };
    const bridge = createDesktopBridge(ipc, "win32", {
      getPathForFile: (file) => `/private/drop/${file.name}`,
    });

    expect(Object.keys(bridge).sort()).toEqual(["dashboard", "desktop"]);
    expect(Object.keys(bridge.dashboard)).toEqual(["call"]);
    expect(Object.keys(bridge.desktop).sort()).toEqual([
      "activateCloudEnrollment",
      "cancelSyntheticPerformerTask",
      "deleteLocalModelCredential",
      "discardConversationFiles",
      "getCloudState",
      "getHealth",
      "getSetupState",
      "getSyntheticPerformerTask",
      "listInputAssets",
      "onCloudStateChanged",
      "onConversationEvent",
      "onConversationStreamEvent",
      "onDashboardInvalidated",
      "onStatusChanged",
      "onSyntheticPerformerTaskChanged",
      "openCloudDestination",
      "openLogsDirectory",
      "openSyntheticPerformerOutput",
      "platform",
      "restartAgent",
      "retryCloudConnection",
      "revealInputAssetSlot",
      "saveLocalModelCredential",
      "saveSetup",
      "selectCloudEnrollment",
      "selectConversationFiles",
      "selectSyntheticPerformerOutput",
      "selectSyntheticPerformerSources",
      "selectWorkspace",
      "selectZiniaoApp",
      "selectZiniaoWebDriverDirectory",
      "stageDroppedConversationFiles",
      "startSyntheticPerformerTask",
    ]);
    expect(bridge.desktop.platform).toBe("win32");
    await bridge.dashboard.call({ operation: "models.list", input: {} });
    await bridge.desktop.saveLocalModelCredential({ provider: "deepseek", api_key: "local-key" });
    await bridge.desktop.deleteLocalModelCredential("deepseek");
    await bridge.desktop.selectCloudEnrollment();
    await bridge.desktop.activateCloudEnrollment({ enrollment_id: "enroll-123", password: "password-value" });
    await bridge.desktop.getCloudState();
    await bridge.desktop.retryCloudConnection();
    await bridge.desktop.openCloudDestination("erp_dashboard");
    await bridge.desktop.selectZiniaoApp();
    await bridge.desktop.selectZiniaoWebDriverDirectory();
    await bridge.desktop.openLogsDirectory();
    await bridge.desktop.getHealth();
    await bridge.desktop.selectSyntheticPerformerSources("files");
    await bridge.desktop.selectSyntheticPerformerOutput();
    await bridge.desktop.startSyntheticPerformerTask({
      action: "scan",
      selection_id: "selection-1",
      recursive: false,
    });
    await bridge.desktop.getSyntheticPerformerTask();
    await bridge.desktop.cancelSyntheticPerformerTask("task-1");
    await bridge.desktop.openSyntheticPerformerOutput("task-1");
    await bridge.desktop.selectConversationFiles();
    await bridge.desktop.stageDroppedConversationFiles([new File(["hello"], "notes.txt")]);
    await bridge.desktop.discardConversationFiles(["attachment-1"]);
    let cloudConnection = "";
    const unsubscribeCloud = bridge.desktop.onCloudStateChanged((state) => {
      cloudConnection = state.connection;
    });
    listeners.get(IPC_CHANNELS.cloudStateChanged)?.({}, {
      configured: true,
      is_admin: false,
      device_name: "Finance PC",
      device_id: "device01",
      vpn_ip: "10.88.0.3",
      connection: "connected",
      last_error: "",
      last_checked_at: 123,
    });
    expect(cloudConnection).toBe("connected");
    unsubscribeCloud();
    expect(listeners.has(IPC_CHANNELS.cloudStateChanged)).toBe(false);
    let conversationSession = "";
    const unsubscribeConversation = bridge.desktop.onConversationEvent((event) => {
      conversationSession = event.activity.session_id;
    });
    listeners.get(IPC_CHANNELS.conversationEvent)?.({}, {
      activity: { session_id: "session-1", active: null, queued: [], latest: null },
    });
    expect(conversationSession).toBe("session-1");
    unsubscribeConversation();
    expect(listeners.has(IPC_CHANNELS.conversationEvent)).toBe(false);
    let streamSequence = 0;
    const unsubscribeStream = bridge.desktop.onConversationStreamEvent((event) => {
      streamSequence = event.batch.seq;
    });
    listeners.get(IPC_CHANNELS.conversationStreamEvent)?.({}, {
      batch: { session_id: "session-1", turn_id: "turn-1", emit_id: "emit-1", seq: 3, mutations: [] },
    });
    expect(streamSequence).toBe(3);
    unsubscribeStream();
    expect(listeners.has(IPC_CHANNELS.conversationStreamEvent)).toBe(false);
    const unsubscribe = bridge.desktop.onStatusChanged(() => undefined);
    expect(listeners.has(IPC_CHANNELS.statusChanged)).toBe(true);
    unsubscribe();
    expect(listeners.has(IPC_CHANNELS.statusChanged)).toBe(false);
    let revision = 0;
    const unsubscribeInvalidation = bridge.desktop.onDashboardInvalidated((event) => {
      revision = event.revision;
    });
    listeners.get(IPC_CHANNELS.dashboardInvalidated)?.({}, {
      revision: 7,
      domains: ["sessions"],
      session_ids: ["session-1"],
    });
    expect(revision).toBe(7);
    unsubscribeInvalidation();
    expect(listeners.has(IPC_CHANNELS.dashboardInvalidated)).toBe(false);
    let mediaTaskId = "";
    const unsubscribeMediaTask = bridge.desktop.onSyntheticPerformerTaskChanged((task) => {
      mediaTaskId = task.task_id;
    });
    listeners.get(IPC_CHANNELS.syntheticPerformerTaskChanged)?.({}, {
      task_id: "task-1",
      action: "scan",
      state: "running",
      stage: "scan",
      processed: 1,
      total: 2,
      current_file: "sample.jpg",
      selection_id: "selection-1",
      recursive: false,
      items: [],
      counts: {},
      error: "",
    });
    expect(mediaTaskId).toBe("task-1");
    unsubscribeMediaTask();
    expect(listeners.has(IPC_CHANNELS.syntheticPerformerTaskChanged)).toBe(false);
    expect(invocations.map((item) => item.channel)).toEqual([
      IPC_CHANNELS.dashboardCall,
      IPC_CHANNELS.saveLocalModelCredential,
      IPC_CHANNELS.deleteLocalModelCredential,
      IPC_CHANNELS.selectCloudEnrollment,
      IPC_CHANNELS.activateCloudEnrollment,
      IPC_CHANNELS.getCloudState,
      IPC_CHANNELS.retryCloudConnection,
      IPC_CHANNELS.openCloudDestination,
      IPC_CHANNELS.selectZiniaoApp,
      IPC_CHANNELS.selectZiniaoWebDriverDirectory,
      IPC_CHANNELS.openLogsDirectory,
      IPC_CHANNELS.getHealth,
      IPC_CHANNELS.selectSyntheticPerformerSources,
      IPC_CHANNELS.selectSyntheticPerformerOutput,
      IPC_CHANNELS.startSyntheticPerformerTask,
      IPC_CHANNELS.getSyntheticPerformerTask,
      IPC_CHANNELS.cancelSyntheticPerformerTask,
      IPC_CHANNELS.openSyntheticPerformerOutput,
      IPC_CHANNELS.selectConversationFiles,
      IPC_CHANNELS.stageDroppedConversationFiles,
      IPC_CHANNELS.discardConversationFiles,
    ]);
    expect(invocations[19]?.arguments).toEqual([["/private/drop/notes.txt"]]);
    expect(invocations[20]?.arguments).toEqual([["attachment-1"]]);
    expect(invocations[1]?.arguments).toEqual([{ provider: "deepseek", api_key: "local-key" }]);
    expect(invocations[2]?.arguments).toEqual(["deepseek"]);
    expect(invocations[4]?.arguments).toEqual([{ enrollment_id: "enroll-123", password: "password-value" }]);
    expect(invocations[7]?.arguments).toEqual(["erp_dashboard"]);
    expect(invocations[14]?.arguments).toEqual([{
      action: "scan",
      selection_id: "selection-1",
      recursive: false,
    }]);
  });
});
