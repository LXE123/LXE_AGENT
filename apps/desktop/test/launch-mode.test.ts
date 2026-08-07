import { describe, expect, test } from "bun:test";
import {
  isAllowedDesktopNavigation,
  isExternallyOpenableUrl,
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

  // openExternal asks the operating system to run the handler registered for
  // the scheme, so anything past http(s) turns a link in a conversation into a
  // way to start something on the user's machine.
  test("hands only plain web traffic to the system browser", () => {
    expect(isExternallyOpenableUrl("https://www.baidu.com/s?wd=1")).toBeTrue();
    expect(isExternallyOpenableUrl("http://example.com")).toBeTrue();

    expect(isExternallyOpenableUrl("file:///etc/passwd")).toBeFalse();
    expect(isExternallyOpenableUrl("javascript:alert(1)")).toBeFalse();
    expect(isExternallyOpenableUrl("mailto:someone@example.com")).toBeFalse();
    expect(isExternallyOpenableUrl("app://lxe/")).toBeFalse();
    expect(isExternallyOpenableUrl("ms-msdt:/id")).toBeFalse();
    expect(isExternallyOpenableUrl("HTTPS://example.com")).toBeTrue();
    expect(isExternallyOpenableUrl("https://user:pass@example.com")).toBeFalse();
    expect(isExternallyOpenableUrl("https://")).toBeFalse();
    expect(isExternallyOpenableUrl("not a url")).toBeFalse();
    expect(isExternallyOpenableUrl("")).toBeFalse();
  });
});
