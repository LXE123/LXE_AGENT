import { expect, test } from "bun:test";
import { sendEditingShortcut, titlebarMenuTemplate, validateTitlebarMenu } from "../src/main/app-shell/titlebar-menu";
import { createDesktopBridge } from "../src/preload-bridge";
import { IPC_CHANNELS } from "../src/ipc-channels";

test("caption bridge forwards the request and returns the selected application action", async () => {
  const request = { menu: "application", language: "zh", x: 48, y: 34 } as const;
  const api = createDesktopBridge({
    invoke: async <T>(channel: string, ...args: unknown[]) => {
      expect(channel).toBe(IPC_CHANNELS.showTitlebarMenu); expect(args).toEqual([request]);
      return "settings" as T;
    }, on() {}, removeListener() {},
  }, "win32");
  expect(await api.desktop.showTitlebarMenu!(request)).toBe("settings");
});

test("native menu rejects unknown commands, locales and invalid coordinates", () => {
  const input = { menu: "edit", language: "en", x: 48, y: 34 };
  expect(validateTitlebarMenu(input)).toEqual(input);
  for (const patch of [{ menu: "quit" }, { language: "xx" }, { x: NaN }, { x: -1 }, { y: Infinity }, { y: "34" }, { x: 100001 }]) {
    expect(() => validateTitlebarMenu({ ...input, ...patch })).toThrow("Invalid desktop titlebar");
  }
});

test("application menu uses existing settings, updater and quit callbacks", () => {
  const selected: unknown[] = [];
  const menu = titlebarMenuTemplate({ menu: "application", language: "zh", x: 0, y: 0 }, {
    select: action => selected.push(action), edit() {}, quit: () => selected.push("quit"), canCheckUpdates: false,
  });
  expect(menu.map(item => item.label ?? item.type)).toEqual(["设置", "检查更新", "separator", "退出"]);
  expect(menu[1]!.enabled).toBe(false);
  for (const index of [0, 1, 3]) (menu[index]!.click as () => void)();
  expect(selected).toEqual(["settings", "check-updates", "quit"]);
});

test("editing shortcuts dispatch key events to editor history without global accelerators", () => {
  const keys: string[] = [], events: unknown[] = [];
  const menu = titlebarMenuTemplate({ menu: "edit", language: "en", x: 0, y: 0 }, {
    select() {}, quit() {}, canCheckUpdates: true, edit: key => keys.push(key),
  });
  for (const item of menu.filter(item => item.type !== "separator")) {
    expect(item.registerAccelerator).toBe(false);
    (item.click as () => void)();
  }
  expect(keys).toEqual(["Z", "Y", "X", "C", "V", "A"]);
  sendEditingShortcut(event => events.push(event), "Z");
  expect(events).toEqual([
    { type: "keyDown", keyCode: "Z", modifiers: ["control"] },
    { type: "keyUp", keyCode: "Z", modifiers: ["control"] },
  ]);
});
