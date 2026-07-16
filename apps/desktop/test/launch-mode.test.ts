import { describe, expect, test } from "bun:test";
import {
  desktopPreviewDataRoot,
  isAllowedDesktopNavigation,
  resolveDesktopLaunchMode,
  usesPackagedRuntime,
  usesProductionRenderer,
} from "../src/main/launch-mode";

describe("desktop launch mode", () => {
  test("selects development, preview, and packaged without conflating their runtimes", () => {
    const development = resolveDesktopLaunchMode({ packaged: false });
    const preview = resolveDesktopLaunchMode({ packaged: false, previewFlag: "1" });
    const packaged = resolveDesktopLaunchMode({ packaged: true, previewFlag: "1" });

    expect(development).toBe("development");
    expect(preview).toBe("preview");
    expect(packaged).toBe("packaged");
    expect(usesProductionRenderer(development)).toBeFalse();
    expect(usesProductionRenderer(preview)).toBeTrue();
    expect(usesProductionRenderer(packaged)).toBeTrue();
    expect(usesPackagedRuntime(development)).toBeFalse();
    expect(usesPackagedRuntime(preview)).toBeFalse();
    expect(usesPackagedRuntime(packaged)).toBeTrue();
  });

  test("requires the exact internal preview flag", () => {
    expect(resolveDesktopLaunchMode({ packaged: false, previewFlag: "true" })).toBe("development");
    expect(resolveDesktopLaunchMode({ packaged: false, previewFlag: " 1 " })).toBe("development");
  });

  test("uses an isolated persistent preview directory on Windows and macOS", () => {
    expect(desktopPreviewDataRoot("C:\\Users\\tester\\AppData\\Roaming", "win32"))
      .toBe("C:\\Users\\tester\\AppData\\Roaming\\LXE Agent Preview");
    expect(desktopPreviewDataRoot("/Users/tester/Library/Application Support", "darwin"))
      .toBe("/Users/tester/Library/Application Support/LXE Agent Preview");
  });

  test("allows only the selected Renderer origin", () => {
    const developmentUrl = "http://127.0.0.1:5173";
    expect(isAllowedDesktopNavigation("http://127.0.0.1:5173/tasks/1", "development", developmentUrl))
      .toBeTrue();
    expect(isAllowedDesktopNavigation("app://lxe/settings", "development", developmentUrl)).toBeFalse();
    expect(isAllowedDesktopNavigation("app://lxe/settings", "preview", developmentUrl)).toBeTrue();
    expect(isAllowedDesktopNavigation("app://lxe/", "packaged", developmentUrl)).toBeTrue();
    expect(isAllowedDesktopNavigation("app://other/", "preview", developmentUrl)).toBeFalse();
    expect(isAllowedDesktopNavigation("https://example.com/", "packaged", developmentUrl)).toBeFalse();
    expect(isAllowedDesktopNavigation("not a url", "preview", developmentUrl)).toBeFalse();
  });
});
