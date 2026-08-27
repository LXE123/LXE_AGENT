import type { DesktopPlatform } from "@lxe/desktop-protocol";
import type { BrowserWindowConstructorOptions } from "electron";

export const DESKTOP_TITLEBAR_HEIGHT = 40;

export type DesktopAppearance = "light" | "dark";

/**
 * The caption strip Windows draws its own buttons on.
 *
 * macOS keeps its controls under the system's appearance and needs nothing
 * here. Windows takes the colour from us once and holds it, so a strip left at
 * the light theme's value stays light behind a dark page — matching the
 * renderer's `--bg` and `--text-soft` is what keeps it part of the window.
 */
export const DESKTOP_TITLEBAR_COLOURS: Record<DesktopAppearance, { color: string; symbolColor: string }> = {
  light: { color: "#fafaf9", symbolColor: "#5d544a" },
  dark: { color: "#242322", symbolColor: "#a89d90" },
};

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
      ...DESKTOP_TITLEBAR_COLOURS.light,
      height: DESKTOP_TITLEBAR_HEIGHT,
    },
  };
};
