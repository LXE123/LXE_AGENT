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

/**
 * Whether a link may be handed to the operating system's browser.
 *
 * `shell.openExternal` asks the OS to run whatever handler is registered for
 * the scheme, so anything beyond plain web traffic — `file:`, `javascript:`, a
 * third-party app's custom scheme — turns a link in a conversation into a way
 * to launch something on the user's machine. Only http(s) qualifies, and the
 * URL has to be one the OS will hand to a browser: no embedded credentials.
 */
export function isExternallyOpenableUrl(target: string): boolean {
  try {
    const parsed = new URL(target);
    return (parsed.protocol === "https:" || parsed.protocol === "http:")
      && parsed.username === ""
      && parsed.password === "";
  } catch {
    return false;
  }
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
