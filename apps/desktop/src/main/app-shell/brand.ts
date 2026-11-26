import type { DesktopPlatform } from "@lxe/desktop-protocol";
import { nativeImage } from "electron";
import type { DesktopBrandAssets } from "./brand-assets";
import { loadDesktopTrayImage } from "./brand-assets";

export const createTrayIcon = (
  platform: DesktopPlatform,
  assets: DesktopBrandAssets,
): Electron.NativeImage => loadDesktopTrayImage(
  platform,
  assets,
  (path) => nativeImage.createFromPath(path),
);
