import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "..", "..", "..");
const readJson = (path: string): { scripts?: Record<string, string> } =>
  JSON.parse(readFileSync(join(repositoryRoot, path), "utf8")) as {
    scripts?: Record<string, string>;
  };

describe("Windows desktop packaging routes", () => {
  test("exposes a distinct unpacked route without weakening the release gate", () => {
    const workspaceScripts = readJson("package.json").scripts ?? {};
    const desktopScripts = readJson("apps/desktop/package.json").scripts ?? {};

    expect(workspaceScripts["desktop:pack:win"]).toContain("-PackageTarget Unpacked");
    expect(workspaceScripts["desktop:dist:win"]).not.toContain("-PackageTarget Unpacked");
    expect(workspaceScripts["verify:platform:win"]).toContain("desktop:dist:win");
    expect(workspaceScripts["verify:platform:win"]).not.toContain("desktop:pack:win");

    expect(desktopScripts["pack:win"]).toContain("--dir --x64");
    expect(desktopScripts["pack:win"]).toContain("dist/desktop-unpacked");
    expect(desktopScripts["pack:win"]).not.toContain("nsis");
    expect(desktopScripts["dist:win"]).toContain("--win nsis --x64");
  });

  test("keeps packaged checks on both wrapper targets", () => {
    const wrapper = readFileSync(
      join(repositoryRoot, "scripts", "build-desktop-windows.ps1"),
      "utf8",
    );

    expect(wrapper).toMatch(/ValidateSet\("Nsis", "Unpacked"\)/u);
    expect(wrapper).toMatch(/\[string\]\$PackageTarget = "Nsis"/u);
    expect(wrapper).toContain('if ($PackageTarget -eq "Unpacked")');
    expect(wrapper).toContain('"dist\\desktop-unpacked"');
    expect(wrapper).toContain('"Build unpacked Electron application"');
    expect(wrapper).toContain('"Build NSIS installer"');
    expect(wrapper).toContain('"Enforce desktop resource size budgets"');
    expect(wrapper).toContain('"Smoke packaged Electron preload and IPC"');
    expect(wrapper).toContain("Write-LxeDesktopBuildTimingSummary");
  });
});
