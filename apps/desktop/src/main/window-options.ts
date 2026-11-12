import type { DesktopPlatform } from "@lxe/desktop-protocol";
import type { BrowserWindowConstructorOptions } from "electron";

export const DESKTOP_TITLEBAR_HEIGHT = 40;

export type DesktopAppearance = "light" | "dark";

/**
 * The caption strip Windows draws its own buttons on.
 *
 * macOS keeps its controls under nativeTheme and needs nothing
 * here. Windows takes the colour from us once and holds it, so a strip left at
 * the light theme's value stays light behind a dark page — matching the
 * renderer's `--cds-surface-chrome` and `--cds-secondary` keeps it part of the window.
 */
export const DESKTOP_TITLEBAR_COLOURS: Record<DesktopAppearance, { color: string; symbolColor: string }> = {
  light: { color: "#f7f7f6", symbolColor: "#52514e" },
  dark: { color: "#1a1a19", symbolColor: "#bfbdb5" },
};

/** Native Windows caption buttons use the same chrome palette as the renderer. */
export const WINDOWS_TITLEBAR_COLOURS = DESKTOP_TITLEBAR_COLOURS;

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
      ...(platform === "win32" ? WINDOWS_TITLEBAR_COLOURS.light : DESKTOP_TITLEBAR_COLOURS.light),
      height: DESKTOP_TITLEBAR_HEIGHT,
    },
  };
};
