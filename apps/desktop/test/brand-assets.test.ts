import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  loadDesktopTrayImage,
  resolveDesktopBrandAssets,
  type TrayImageLike,
} from "../src/main/brand-assets";

const desktopRoot = join(import.meta.dir, "..");

class TestImage implements TrayImageLike {
  template = false;

  constructor(private readonly empty: boolean) {}

  isEmpty(): boolean {
    return this.empty;
  }

  setTemplateImage(template: boolean): void {
    this.template = template;
  }
}

describe("desktop brand assets", () => {
  test("resolves source and packaged assets without conflating launch modes", () => {
    expect(resolveDesktopBrandAssets({
      packaged: false,
      platform: "win32",
      resourcesPath: "/resources",
      sourceRoot: "/source",
    })).toEqual({
      appIconPath: join("/source", "apps", "desktop", "build", "icon-win.png"),
      trayFallbackPath: join("/source", "apps", "desktop", "build", "icon-win.png"),
      trayIconPath: join("/source", "apps", "desktop", "build", "tray-win.ico"),
    });
    expect(resolveDesktopBrandAssets({
      packaged: true,
      platform: "darwin",
      resourcesPath: "/resources",
      sourceRoot: "/source",
    })).toEqual({
      appIconPath: join("/resources", "branding", "icon-mac.png"),
      trayFallbackPath: join("/resources", "branding", "icon-mac.png"),
      trayIconPath: join("/resources", "branding", "tray-macTemplate.png"),
    });
  });

  test("uses the tray asset, falls back once, and never returns an empty image", () => {
    const assets = resolveDesktopBrandAssets({
      packaged: false,
      platform: "win32",
      resourcesPath: "/resources",
      sourceRoot: "/source",
    });
    const primary = new TestImage(false);
    expect(loadDesktopTrayImage("win32", assets, () => primary)).toBe(primary);

    const fallback = new TestImage(false);
    const calls: string[] = [];
    expect(loadDesktopTrayImage("win32", assets, (path) => {
      calls.push(path);
      return path.endsWith(".ico") ? new TestImage(true) : fallback;
    })).toBe(fallback);
    expect(calls).toEqual([assets.trayIconPath, assets.trayFallbackPath]);

    expect(() => loadDesktopTrayImage("win32", assets, () => new TestImage(true))).toThrow(
      "Desktop tray icon is empty",
    );
  });

  test("marks macOS assets as templates and ships every Windows ICO size", () => {
    const assets = resolveDesktopBrandAssets({
      packaged: false,
      platform: "darwin",
      resourcesPath: "/resources",
      sourceRoot: "/source",
    });
    const image = new TestImage(false);
    expect(loadDesktopTrayImage("darwin", assets, () => image)).toBe(image);
    expect(image.template).toBe(true);

    const ico = readFileSync(join(desktopRoot, "build", "tray-win.ico"));
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    const count = ico.readUInt16LE(4);
    expect(count).toBe(6);
    const sizes = Array.from({ length: count }, (_, index) => {
      const width = ico[6 + index * 16];
      return width === 0 ? 256 : width;
    });
    expect(sizes).toEqual([16, 20, 24, 32, 40, 48]);
  });
});
