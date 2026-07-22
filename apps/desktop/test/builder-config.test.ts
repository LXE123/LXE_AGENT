import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  desktopBuilderConfigPath,
  validateDesktopBuilderConfig,
} from "../scripts/validate-builder-config";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("electron-builder configuration", () => {
  test("matches the schema bundled with the pinned electron-builder", async () => {
    await expect(validateDesktopBuilderConfig()).resolves.toBeUndefined();
    const config = readFileSync(desktopBuilderConfigPath, "utf8");
    expect(config).toMatch(/electronLanguages:\r?\n  - en-US\r?\n  - zh-CN/u);
    expect(config).toMatch(/buildResources: build/u);
    expect(config).toMatch(/win:\r?\n  icon: icon-win\.png/u);
    expect(config).toMatch(/mac:\r?\n  icon: icon-mac\.png/u);
    expect(config).toMatch(/nsis:\r?\n  include: resources\/installer\.nsh/u);
    expect(config).toMatch(
      /nsis:\r?\n  include: resources\/installer\.nsh\r?\n  useZip: true(?:\r?\n  #.*){2}\r?\n  differentialPackage: false/u,
    );
    expect(config).toMatch(/files:\r?\n  - dist\/main\.js\r?\n  - dist\/preload\.cjs/u);
    expect(config).not.toContain("dist/**/*");
    expect(config).not.toMatch(/from: build\r?\n    to: branding/u);
    const desktopRoot = dirname(desktopBuilderConfigPath);
    expect(existsSync(join(desktopRoot, "build", "icon-win.png"))).toBe(true);
    expect(existsSync(join(desktopRoot, "build", "icon-mac.png"))).toBe(true);
    expect(existsSync(join(desktopRoot, "build", "tray-win.ico"))).toBe(true);
    expect(existsSync(join(desktopRoot, "build", "tray-macTemplate.png"))).toBe(true);
    expect(existsSync(join(desktopRoot, "build", "tray-macTemplate@2x.png"))).toBe(true);
    expect(existsSync(join(desktopRoot, "resources", "installer.nsh"))).toBe(true);
  });

  test("identifies an unknown Windows option during source tests", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-builder-config-"));
    temporaryRoots.push(root);

    const sourceConfig = readFileSync(desktopBuilderConfigPath, "utf8");
    const invalidConfig = sourceConfig.replace(
      /^win:(\r?\n)/mu,
      (_match, lineEnding: string) => [
        "win:",
        "  signingHashAlgorithms:",
        "    - sha256",
        "",
      ].join(lineEnding),
    );
    if (invalidConfig === sourceConfig) throw new Error("Windows builder configuration block was not found");
    const invalidConfigPath = join(root, "electron-builder.yml");
    writeFileSync(invalidConfigPath, invalidConfig, "utf8");

    await expect(validateDesktopBuilderConfig(invalidConfigPath)).rejects.toThrow(
      "configuration.win has an unknown property 'signingHashAlgorithms'",
    );
  }, 30_000);
});
