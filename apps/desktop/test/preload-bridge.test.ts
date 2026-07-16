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
    expect(Object.keys(bridge.dashboard)).toEqual(["request"]);
    expect(Object.keys(bridge.desktop).sort()).toEqual([
      "getHealth",
      "getSetupState",
      "onStatusChanged",
      "platform",
      "restartAgent",
      "saveSetup",
      "selectWorkspace",
    ]);
    expect(bridge.desktop.platform).toBe("win32");
    await bridge.dashboard.request({ method: "GET", path: "/api/models" });
    await bridge.desktop.getHealth();
    const unsubscribe = bridge.desktop.onStatusChanged(() => undefined);
    expect(listeners.has(IPC_CHANNELS.statusChanged)).toBe(true);
    unsubscribe();
    expect(listeners.has(IPC_CHANNELS.statusChanged)).toBe(false);
    expect(invocations.map((item) => item.channel)).toEqual([
      IPC_CHANNELS.dashboardRequest,
      IPC_CHANNELS.getHealth,
    ]);
  });
});
