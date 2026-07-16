import { describe, expect, test } from "bun:test";
import { desktopWindowAppearance, DESKTOP_TITLEBAR_HEIGHT } from "../src/main/window-options";
import { normalizeDesktopPlatform } from "../src/platform";

describe("desktop window appearance", () => {
  test("keeps Windows native controls in a branded overlay", () => {
    expect(desktopWindowAppearance("win32")).toEqual({
      autoHideMenuBar: true,
      titleBarStyle: "hidden",
      titleBarOverlay: {
        color: "#faf8f5",
        symbolColor: "#5d544a",
        height: DESKTOP_TITLEBAR_HEIGHT,
      },
    });
  });

  test("uses inset native traffic lights on macOS", () => {
    expect(desktopWindowAppearance("darwin")).toEqual({
      autoHideMenuBar: false,
      titleBarStyle: "hiddenInset",
    });
  });

  test("normalizes unsupported Node platforms to the Linux desktop style", () => {
    expect(normalizeDesktopPlatform("win32")).toBe("win32");
    expect(normalizeDesktopPlatform("darwin")).toBe("darwin");
    expect(normalizeDesktopPlatform("freebsd")).toBe("linux");
  });
});
