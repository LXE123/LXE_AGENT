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

  test("keeps production steps without packaged resource re-audits", () => {
    const wrapper = readFileSync(
      join(repositoryRoot, "scripts", "build-desktop-windows.ps1"),
      "utf8",
    );

    expect(wrapper).toMatch(/ValidateSet\("Nsis", "Unpacked"\)/u);
    expect(wrapper).toMatch(/\[string\]\$PackageTarget = "Nsis"/u);
    expect(wrapper).toContain('if ($PackageTarget -eq "Unpacked")');
    expect(wrapper).toContain('"dist\\desktop-unpacked"');
    expect(wrapper).toContain('"Build unpacked Electron application"');
    expect(wrapper).toMatch(
      /else \{\s+\$packageOutputRoot = Join-Path \$repositoryRoot "dist\\desktop"\s+if \(Test-Path -LiteralPath \$packageOutputRoot\) \{\s+Remove-Item -LiteralPath \$packageOutputRoot -Recurse -Force\s+\}\s+Invoke-LxeDesktopBuildStep -Label "Build NSIS installer"/u,
    );
    expect(wrapper).toContain('"Build NSIS installer"');
    expect(wrapper).toContain('"Enforce desktop resource size budgets"');
    expect(wrapper).toContain('"Smoke packaged Electron preload and IPC"');
    expect(wrapper).not.toContain("audit-packaged-desktop");
    expect(wrapper).not.toContain("Re-audit packaged desktop resources after smoke");
    expect(wrapper).toContain("Write-LxeDesktopBuildTimingSummary");
  });

  test("does not restore file-change manifests or supply-chain checksum gates", () => {
    const desktopMain = readFileSync(join(repositoryRoot, "apps", "desktop", "src", "main.ts"), "utf8");
    const runtimePreparation = readFileSync(
      join(repositoryRoot, "scripts", "prepare-desktop-runtime.ps1"),
      "utf8",
    );
    const resourcePreparation = readFileSync(
      join(repositoryRoot, "scripts", "prepare-desktop-resources.ts"),
      "utf8",
    );
    const runtimeLock = readFileSync(
      join(repositoryRoot, "config", "desktop-runtime", "windows-x64", "runtime.lock.json"),
      "utf8",
    );

    expect(desktopMain).not.toContain("verifyDesktopResourceManifest");
    expect(desktopMain).not.toContain("resourceManifestPath");
    expect(runtimePreparation).not.toContain("critical_files");
    expect(runtimePreparation).not.toContain('Write-LxeUtf8NoBom -Path (Join-Path $Root "runtime-manifest.json")');
    expect(runtimePreparation).not.toContain("ExpectedSha256");
    expect(runtimePreparation).not.toContain("--require-hashes");
    expect(runtimePreparation).toContain('"--no-hashes"');
    expect(resourcePreparation).not.toContain("createHash");
    expect(resourcePreparation).not.toContain("catalog differs");
    expect(runtimeLock).not.toContain("sha256");
  });
});
