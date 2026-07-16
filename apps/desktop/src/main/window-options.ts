import type { DesktopPlatform } from "@lxe/desktop-protocol";
import type { BrowserWindowConstructorOptions } from "electron";

export const DESKTOP_TITLEBAR_HEIGHT = 40;

type WindowAppearance = Pick<
  BrowserWindowConstructorOptions,
  "autoHideMenuBar" | "titleBarOverlay" | "titleBarStyle"
>;

/** Preserve native controls while letting the renderer own the title-bar surface. */
export const desktopWindowAppearance = (platform: DesktopPlatform): WindowAppearance => {
  if (platform === "darwin") {
    return {
      autoHideMenuBar: false,
      titleBarStyle: "hiddenInset",
    };
  }
  return {
    autoHideMenuBar: true,
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#faf8f5",
      symbolColor: "#5d544a",
      height: DESKTOP_TITLEBAR_HEIGHT,
    },
  };
};
