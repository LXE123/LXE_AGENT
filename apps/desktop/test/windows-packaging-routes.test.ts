import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "..", "..", "..");
const readJson = (path: string): { scripts?: Record<string, string> } =>
  JSON.parse(readFileSync(join(repositoryRoot, path), "utf8")) as {
    scripts?: Record<string, string>;
  };

describe("Windows desktop packaging routes", () => {
  test("separates one source verification from one production build", () => {
    const workspaceScripts = readJson("package.json").scripts ?? {};
    const sourceVerification = workspaceScripts["verify:source"] ?? "";
    const releaseVerification = workspaceScripts["verify:platform:win"] ?? "";

    expect(sourceVerification).toContain("check:ts-boundary");
    expect(sourceVerification).toContain("typecheck");
    expect(sourceVerification).toContain("bun run test");
    expect(sourceVerification).toContain("test:py-tools");
    expect(sourceVerification).not.toMatch(/uv build|agent-cli:compile|desktop:build|desktop:dist:win/u);
    expect(workspaceScripts.verify).toBe("bun run verify:source");
    expect(workspaceScripts["verify:platform"]).toBe("bun run verify:source");
    expect(releaseVerification).toBe(
      "bun scripts/assert-host-platform.ts win32 x64 && bun run verify:source && bun run desktop:dist:win",
    );
    expect(workspaceScripts["verify:platform:mac"]).toBe(
      "bun scripts/assert-host-platform.ts darwin && bun run verify:source",
    );
    expect(workspaceScripts["desktop:validate:config"]).toBeUndefined();
  });

  test("exposes a distinct unpacked route without weakening the release gate", () => {
    const workspaceScripts = readJson("package.json").scripts ?? {};
    const desktopScripts = readJson("apps/desktop/package.json").scripts ?? {};

    expect(workspaceScripts["desktop:pack:win"]).toContain("-PackageTarget Unpacked");
    expect(workspaceScripts["desktop:dist:win"]).not.toContain("-PackageTarget Unpacked");
    expect(workspaceScripts["verify:platform:win"]).toContain("desktop:dist:win");
    expect(workspaceScripts["verify:platform:win"]).not.toContain("desktop:pack:win");

    expect(desktopScripts["pack:win"]).toContain("--dir --x64");
    expect(desktopScripts["pack:win"]).toContain("dist/desktop-unpacked");
    expect(desktopScripts["pack:win"]).toContain("build/desktop-publish/electron-builder.json");
    expect(desktopScripts["pack:win"]).not.toContain("nsis");
    expect(desktopScripts["dist:win"]).toContain("--win nsis --x64");
    expect(desktopScripts["dist:win"]).toContain("build/desktop-publish/electron-builder.json");
  });

  test("keeps one set of production steps without independent pre-validation", () => {
    const wrapper = readFileSync(
      join(repositoryRoot, "scripts", "build-desktop-windows.ps1"),
      "utf8",
    );

    expect(wrapper).toMatch(/ValidateSet\("Nsis", "Unpacked"\)/u);
    expect(wrapper).toMatch(/\[string\]\$PackageTarget = "Nsis"/u);
    expect(wrapper).toMatch(
      /if \(\$PackageTarget -eq "Nsis"\) \{\s+\$versionSelector = Join-Path \$repositoryRoot "apps\\desktop\\scripts\\select-desktop-version\.ts"/u,
    );
    expect(wrapper).toContain('Write-Host "==> Select desktop product version"');
    expect(wrapper.match(/select-desktop-version\.ts/gu)).toHaveLength(1);
    expect(wrapper).toContain('if ($PackageTarget -eq "Unpacked")');
    expect(wrapper).toContain('"dist\\desktop-unpacked"');
    expect(wrapper).toContain('"Build unpacked Electron application"');
    expect(wrapper).toMatch(
      /else \{\s+\$packageOutputRoot = Join-Path \$repositoryRoot "dist\\desktop"\s+if \(Test-Path -LiteralPath \$packageOutputRoot\) \{\s+Remove-Item -LiteralPath \$packageOutputRoot -Recurse -Force\s+\}\s+Invoke-LxeDesktopBuildStep -Label "Build NSIS installer"/u,
    );
    expect(wrapper).toContain('"Build NSIS installer"');
    expect(wrapper).toContain('"Enforce desktop resource size budgets"');
    expect(wrapper.match(/"Build current LXE project wheel"/gu)).toHaveLength(1);
    expect(wrapper.match(/"Compile private agent-cli"/gu)).toHaveLength(1);
    expect(wrapper.match(/"Build Dashboard and Electron"/gu)).toHaveLength(1);
    expect(wrapper).not.toContain("desktop:validate:config");
    expect(wrapper).not.toContain("Validate electron-builder configuration");
    expect(wrapper).not.toContain("smoke-packaged-app");
    expect(wrapper).not.toContain("Smoke packaged Electron");
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
    const runtimeInputs = readFileSync(
      join(repositoryRoot, "scripts", "desktop-runtime-inputs.ts"),
      "utf8",
    );
    const runtimeLock = readFileSync(
      join(repositoryRoot, "config", "desktop-runtime", "windows-x64", "runtime.lock.json"),
      "utf8",
    );
    const desktopScripts = readJson("apps/desktop/package.json").scripts ?? {};
    const builderConfig = readFileSync(
      join(repositoryRoot, "apps", "desktop", "electron-builder.yml"),
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
    expect(resourcePreparation).not.toContain("runSmoke");
    expect(resourcePreparation).not.toContain(".lxe-lxeskill-ready.json");
    expect(resourcePreparation).not.toContain("cpSync");
    expect(resourcePreparation).not.toContain("copyDirectory");
    expect(resourcePreparation).not.toContain("copyFileSync");
    expect(resourcePreparation).toContain("python-site-packages");
    expect(resourcePreparation).toContain("exactFileSet(wireGuardMsi");
    expect(resourcePreparation).toContain("builderConfig.extraResources = extraResources");
    expect(builderConfig).not.toContain("build/desktop-resources");
    expect(runtimePreparation).not.toContain("Finalize-LxePublishRuntime");
    expect(runtimePreparation).not.toContain("$forbiddenDirectoryNames");
    expect(runtimePreparation).not.toContain("$lowerName -match");
    expect(runtimePreparation).not.toContain("node_modules\\dingtalk-workspace-cli\\assets");
    expect(runtimePreparation).not.toContain("playwright\\driver\\node.exe");
    expect(runtimePreparation).not.toContain("$packagedLocales");
    expect(runtimePreparation).toContain('"scripts/prepare-desktop-runtime.ps1"');
    expect(runtimeInputs).toContain('"scripts/prepare-desktop-runtime.ps1"');
    expect(runtimePreparation).not.toContain("Copy-LxeDirectoryContents -Source $npmCache");
    expect(runtimePreparation).toContain("desktop-runtime-publish-layout=2");
    expect(runtimeInputs).toContain('desktop-runtime-publish-layout=${desktopRuntimePublishLayout}');
    expect(runtimePreparation).not.toContain("Test-LxeRuntimeImage");
    expect(runtimePreparation).not.toContain("Playwright Chromium smoke");
    expect(desktopScripts["smoke:packaged"]).toBeUndefined();
    expect(desktopScripts["validate:config"]).toBeUndefined();
    expect(runtimeLock).not.toContain("sha256");
  });

  test("excludes only Playwright's embedded Node from the packaged Python runtime", () => {
    const resourcePreparation = readFileSync(
      join(repositoryRoot, "scripts", "prepare-desktop-resources.ts"),
      "utf8",
    );
    const desktopGateway = readFileSync(
      join(repositoryRoot, "apps", "desktop", "src", "main", "desktop-gateway.ts"),
      "utf8",
    );

    expect(resourcePreparation).toContain(
      'const playwrightEmbeddedNodeRelativePath = "Lib/site-packages/playwright/driver/node.exe"',
    );
    expect(resourcePreparation).toContain(
      'filter: ["**/*", `!${playwrightEmbeddedNodeRelativePath}`]',
    );
    expect(resourcePreparation).toContain("playwrightEmbeddedNodeSource");
    expect(resourcePreparation).not.toContain("!Lib/site-packages/playwright/**");
    expect(resourcePreparation).not.toContain("rmSync(playwrightEmbeddedNodeSource");
    expect(resourcePreparation).not.toContain("rmSync(pythonRoot");
    expect(desktopGateway).toContain(
      'PLAYWRIGHT_NODEJS_PATH: join(process.resourcesPath, "runtime", "node", "node.exe")',
    );
  });

  test("pins and packages ExifTool with its Windows support directory", () => {
    const runtimeLock = JSON.parse(readFileSync(
      join(repositoryRoot, "config", "desktop-runtime", "windows-x64", "runtime.lock.json"),
      "utf8",
    )) as { exiftool?: { version?: string; archive_url?: string } };
    const runtimePreparation = readFileSync(
      join(repositoryRoot, "scripts", "prepare-desktop-runtime.ps1"),
      "utf8",
    );
    const resourcePreparation = readFileSync(
      join(repositoryRoot, "scripts", "prepare-desktop-resources.ts"),
      "utf8",
    );
    const buildWrapper = readFileSync(
      join(repositoryRoot, "scripts", "build-desktop-windows.ps1"),
      "utf8",
    );

    expect(runtimeLock.exiftool).toEqual({
      version: "13.59",
      archive_url: "https://downloads.sourceforge.net/project/exiftool/exiftool-13.59_64.zip",
    });
    expect(runtimePreparation).toContain('"exiftool(-k).exe", "exiftool.exe"');
    expect(runtimePreparation).toContain('"tools\\exiftool\\exiftool.exe"');
    expect(runtimePreparation).toContain('"tools\\exiftool\\exiftool_files"');
    expect(resourcePreparation).toContain('from: exifToolRoot');
    expect(resourcePreparation).toContain('`${scopeEntry("runtime-tools").target}/exiftool`');
    expect(resourcePreparation).toContain('join(exifToolRoot, "exiftool_files")');
    expect(buildWrapper).toContain("LXE_DESKTOP_EXIFTOOL_ROOT");
    expect(buildWrapper).toContain('(Join-Path $effectiveExifToolRoot "exiftool_files")');
  });

  test("resource preparation selects files without semantic scope or Skill validation", () => {
    const resourcePreparation = readFileSync(
      join(repositoryRoot, "scripts", "prepare-desktop-resources.ts"),
      "utf8",
    );
    const pyproject = Bun.TOML.parse(
      readFileSync(join(repositoryRoot, "pyproject.toml"), "utf8"),
    ) as {
      tool?: { hatch?: { build?: { targets?: { wheel?: { packages?: string[] } } } } };
    };
    const builderConfig = Bun.YAML.parse(
      readFileSync(join(repositoryRoot, "apps", "desktop", "electron-builder.yml"), "utf8"),
    ) as { files?: string[] };

    expect(resourcePreparation).toContain("readResourceScope");
    expect(resourcePreparation).toContain("approvedSkillFile");
    expect(resourcePreparation).toContain("gitFiles([skillsSource])");
    expect(resourcePreparation).not.toContain("validateResourceScope");
    expect(resourcePreparation).not.toContain("validateSelectedSkills");
    expect(resourcePreparation).not.toContain("requireManagedScope");
    expect(pyproject.tool?.hatch?.build?.targets?.wheel?.packages).toEqual([
      "python/lxeskill_cli/lxeskill",
      "python/lxeskill_cli/services",
      "python/lxeskill_cli/shared",
      "python/lxeskill_cli/browser_auth_service",
    ]);
    expect(builderConfig.files).toEqual(["dist/main.js", "dist/preload.cjs"]);
  });
});
