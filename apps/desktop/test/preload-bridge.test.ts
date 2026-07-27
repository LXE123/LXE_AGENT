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
    const bridge = createDesktopBridge(ipc, "win32");

    expect(Object.keys(bridge).sort()).toEqual(["dashboard", "desktop"]);
    expect(Object.keys(bridge.dashboard)).toEqual(["call"]);
    expect(Object.keys(bridge.desktop).sort()).toEqual([
      "activateCloudEnrollment",
      "applyConfigImport",
      "discardConfigImport",
      "getCloudState",
      "getHealth",
      "getSetupState",
      "onCloudStateChanged",
      "onConversationEvent",
      "onDashboardInvalidated",
      "onStatusChanged",
      "openLogsDirectory",
      "platform",
      "restartAgent",
      "retryCloudConnection",
      "saveSetup",
      "selectCloudEnrollment",
      "selectConfigImport",
      "selectWorkspace",
      "selectZiniaoApp",
      "selectZiniaoWebDriverDirectory",
    ]);
    expect(bridge.desktop.platform).toBe("win32");
    await bridge.dashboard.call({ operation: "models.list", input: {} });
    await bridge.desktop.selectConfigImport();
    await bridge.desktop.selectCloudEnrollment();
    await bridge.desktop.activateCloudEnrollment({ enrollment_id: "enroll-123", password: "password-value" });
    await bridge.desktop.getCloudState();
    await bridge.desktop.retryCloudConnection();
    await bridge.desktop.applyConfigImport("import-123");
    await bridge.desktop.discardConfigImport("import-123");
    await bridge.desktop.selectZiniaoApp();
    await bridge.desktop.selectZiniaoWebDriverDirectory();
    await bridge.desktop.openLogsDirectory();
    await bridge.desktop.getHealth();
    let cloudConnection = "";
    const unsubscribeCloud = bridge.desktop.onCloudStateChanged((state) => {
      cloudConnection = state.connection;
    });
    listeners.get(IPC_CHANNELS.cloudStateChanged)?.({}, {
      configured: true,
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
    expect(invocations.map((item) => item.channel)).toEqual([
      IPC_CHANNELS.dashboardCall,
      IPC_CHANNELS.selectConfigImport,
      IPC_CHANNELS.selectCloudEnrollment,
      IPC_CHANNELS.activateCloudEnrollment,
      IPC_CHANNELS.getCloudState,
      IPC_CHANNELS.retryCloudConnection,
      IPC_CHANNELS.applyConfigImport,
      IPC_CHANNELS.discardConfigImport,
      IPC_CHANNELS.selectZiniaoApp,
      IPC_CHANNELS.selectZiniaoWebDriverDirectory,
      IPC_CHANNELS.openLogsDirectory,
      IPC_CHANNELS.getHealth,
    ]);
    expect(invocations[3]?.arguments).toEqual([{ enrollment_id: "enroll-123", password: "password-value" }]);
    expect(invocations[6]?.arguments).toEqual(["import-123"]);
    expect(invocations[7]?.arguments).toEqual(["import-123"]);
  });
});
