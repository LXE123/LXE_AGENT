import { posix, win32 } from "node:path";

export type DesktopLaunchMode = "development" | "preview" | "packaged";

export interface DesktopLaunchModeOptions {
  packaged: boolean;
  previewFlag?: string | undefined;
}

export function resolveDesktopLaunchMode(options: DesktopLaunchModeOptions): DesktopLaunchMode {
  if (options.packaged) return "packaged";
  return options.previewFlag === "1" ? "preview" : "development";
}

export const usesProductionRenderer = (mode: DesktopLaunchMode): boolean =>
  mode !== "development";

export const usesPackagedRuntime = (mode: DesktopLaunchMode): boolean =>
  mode === "packaged";

export function desktopPreviewDataRoot(
  appDataPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const targetPath = platform === "win32" ? win32 : posix;
  return targetPath.join(appDataPath, "LXE Agent Preview");
}

export function isAllowedDesktopNavigation(
  target: string,
  mode: DesktopLaunchMode,
  developmentUrl: string,
): boolean {
  try {
    const parsed = new URL(target);
    if (usesProductionRenderer(mode)) {
      return parsed.protocol === "app:"
        && parsed.hostname === "lxe"
        && parsed.username === ""
        && parsed.password === ""
        && parsed.port === "";
    }
    return parsed.origin === new URL(developmentUrl).origin;
  } catch {
    return false;
  }
}
