import { afterEach, expect, mock, test } from "bun:test";
import type { IpcMainInvokeEvent } from "electron";
import type { DesktopAmazonV2Settings } from "@lxe/desktop-protocol";
import type { DesktopIpcApplication } from "../src/main/ipc";
import { IPC_CHANNELS } from "../src/ipc-channels";

const handlers = new Map<string, (...args: unknown[]) => unknown>();
mock.module("electron", () => ({
  app: { getFileIcon: async () => ({ toDataURL: () => "" }) },
  dialog: {},
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => { handlers.set(channel, handler); },
    removeHandler: (channel: string) => { handlers.delete(channel); },
  },
  shell: { openPath: async () => "" },
  clipboard: { readBuffer: () => Buffer.alloc(0), readText: () => "" },
}));

const { registerDesktopIpc } = await import("../src/main/ipc");
let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
  handlers.clear();
});

test("Amazon V2 settings IPC registers, validates, and delegates to the application", async () => {
  const settings: DesktopAmazonV2Settings = { peak_boost_enabled: true, peak_boost_days: 20 };
  const getSettings = mock(async () => settings);
  const saveSettings = mock(async (_input: unknown) => settings);
  const application = {
    isTrustedFileSender: () => true,
    getAmazonV2Settings: getSettings,
    saveAmazonV2Settings: saveSettings,
  } as unknown as DesktopIpcApplication;

  dispose = registerDesktopIpc(application);
  const read = handlers.get(IPC_CHANNELS.getAmazonV2Settings);
  const save = handlers.get(IPC_CHANNELS.saveAmazonV2Settings);
  expect(read).toBeDefined();
  expect(save).toBeDefined();

  const event = {} as IpcMainInvokeEvent;
  expect(await read!(event)).toEqual(settings);
  expect(getSettings).toHaveBeenCalledTimes(1);
  expect(() => save!(event, { peak_boost_enabled: true, peak_boost_days: 121 })).toThrow("peak_boost_days");
  expect(saveSettings).not.toHaveBeenCalled();

  expect(await save!(event, settings)).toEqual(settings);
  expect(saveSettings).toHaveBeenCalledWith(settings);
});
