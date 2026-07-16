import type { DesktopPlatform } from "@lxe/desktop-protocol";

/** Collapse Node's broader platform union to the desktop surfaces we style. */
export const normalizeDesktopPlatform = (platform: string): DesktopPlatform => {
  if (platform === "win32" || platform === "darwin") return platform;
  return "linux";
};
