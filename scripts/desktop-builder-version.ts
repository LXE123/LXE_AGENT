export interface DesktopBuilderConfiguration {
  extraMetadata?: unknown;
  [key: string]: unknown;
}

const desktopProductVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

export function applyDesktopProductVersion(
  builderConfig: DesktopBuilderConfiguration,
  rawVersion: string | undefined,
): void {
  const version = rawVersion?.trim() ?? "";
  if (!desktopProductVersionPattern.test(version)) {
    throw new Error(
      `LXE_DESKTOP_PRODUCT_VERSION must use x.y.z for Windows packaging: ${version || "<missing>"}`,
    );
  }

  const existingExtraMetadata = typeof builderConfig.extraMetadata === "object"
      && builderConfig.extraMetadata !== null
      && !Array.isArray(builderConfig.extraMetadata)
    ? builderConfig.extraMetadata as Record<string, unknown>
    : {};
  builderConfig.extraMetadata = { ...existingExtraMetadata, version };
}
