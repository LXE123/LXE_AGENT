import type { DesktopPlatform } from "@lxe/desktop-protocol";
import { join } from "node:path";

export interface DesktopBrandAssetOptions {
  packaged: boolean;
  platform: DesktopPlatform;
  resourcesPath: string;
  sourceRoot: string;
}

export interface DesktopBrandAssets {
  appIconPath: string;
  trayFallbackPath: string;
  trayIconPath: string;
}

export interface TrayImageLike {
  isEmpty(): boolean;
  setTemplateImage(template: boolean): void;
}

export const resolveDesktopBrandAssets = (
  options: DesktopBrandAssetOptions,
): DesktopBrandAssets => {
  const root = options.packaged
    ? join(options.resourcesPath, "branding")
    : join(options.sourceRoot, "apps", "desktop", "build");
  const appIconName = options.platform === "darwin" ? "icon-mac.png" : "icon-win.png";
  return {
    appIconPath: join(root, appIconName),
    trayFallbackPath: join(root, appIconName),
    trayIconPath: join(
      root,
      options.platform === "darwin" ? "tray-macTemplate.png" : "tray-win.ico",
    ),
  };
};

export const loadDesktopTrayImage = <T extends TrayImageLike>(
  platform: DesktopPlatform,
  assets: DesktopBrandAssets,
  loadImage: (path: string) => T,
): T => {
  const primary = loadImage(assets.trayIconPath);
  const image = primary.isEmpty() ? loadImage(assets.trayFallbackPath) : primary;
  if (image.isEmpty()) {
    throw new Error(
      `Desktop tray icon is empty: ${assets.trayIconPath}; fallback: ${assets.trayFallbackPath}`,
    );
  }
  if (platform === "darwin") image.setTemplateImage(true);
  return image;
};
