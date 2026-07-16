from __future__ import annotations

import json
import os
import shutil
import subprocess
import tomllib
from pathlib import Path

import pytest

from shared.repository import repository_root

ROOT = repository_root()
SCRIPTS = ROOT / "scripts"
BUN_VERSION = "1.3.14"
SOURCE_PRODUCT_BRANCH = "lxe-agent-TUI"


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def test_source_installers_default_to_tui_product_branch() -> None:
    unix_installer = _read(SCRIPTS / "install.sh")
    windows_installer = _read(SCRIPTS / "install.ps1")

    assert f'REF="{SOURCE_PRODUCT_BRANCH}"' in unix_installer
    assert f'[string]$Ref = "{SOURCE_PRODUCT_BRANCH}"' in windows_installer


def test_unix_installer_builds_dashboard_from_frozen_root_bun_workspace() -> None:
    script_path = SCRIPTS / "install.sh"
    script = _read(script_path)

    if os.name != "nt":
        subprocess.run(["bash", "-n", str(script_path)], check=True)
    assert f'BUN_VERSION="{BUN_VERSION}"' in script
    assert '"bun-v$BUN_VERSION"' in script
    assert '"$project_root/package.json"' in script
    assert '"$project_root/bun.lock"' in script
    assert "bun install --frozen-lockfile" in script
    assert "bun run dashboard:build" in script
    assert "package-lock.json" not in script
    assert "npm ci" not in script
    assert r'"\$LXE_ROOT/.venv/bin/python" -I -m lxeskill' in script
    assert "lxeskill-cli" not in script


def test_windows_webui_builds_dashboard_from_frozen_root_bun_workspace() -> None:
    script = _read(SCRIPTS / "webui.ps1")

    assert '"_dependencies.ps1"' in script
    assert f'$BunVersion = "{BUN_VERSION}"' in script
    assert "Resolve-Bun -Version $BunVersion -InstallIfMissing" in script
    assert 'Join-Path $ProjectRoot "package.json"' in script
    assert 'Join-Path $ProjectRoot "bun.lock"' in script
    assert '@("install", "--frozen-lockfile")' in script
    assert '@("run", "dashboard:build")' in script
    assert "package-lock.json" not in script
    assert "npm" not in script.lower()


def test_windows_dependency_helper_installs_and_verifies_exact_bun() -> None:
    helper = _read(SCRIPTS / "_dependencies.ps1")

    assert "function Resolve-Bun" in helper
    assert "function Find-LxeBunCandidates" in helper
    assert "https://bun.sh/install.ps1" in helper
    assert '@("-Version", $Version' in helper
    assert "foreach ($candidate in @(Find-LxeBunCandidates))" in helper
    assert 'throw "Bun $Version is required' in helper
    assert 'throw "Bun installation finished, but Bun $Version is not available.' in helper


def test_windows_dependency_helper_installs_pinned_ripgrep_sidecar() -> None:
    helper = _read(SCRIPTS / "_dependencies.ps1")
    install = _read(SCRIPTS / "install.ps1")
    update = _read(SCRIPTS / "update.ps1")
    doctor = _read(SCRIPTS / "doctor.ps1")

    assert "function Resolve-LxeRipgrep" in helper
    assert "function Test-LxeRipgrepBinary" in helper
    assert "ripgrep-15.1.0-x86_64-pc-windows-msvc.zip" in helper
    assert "124510b94b6baa3380d051fdf4650eaa80a302c876d611e9dba0b2e18d87493a" in helper
    assert "decdd4992f3f1b9a5ef9898f1b40ab16886d579d6516b4efd3d5eaa19364e408" in helper
    assert '".lxe\\tools\\ripgrep\\$Version\\win32-x64\\rg.exe"' in helper
    assert "Move-Item -LiteralPath $stagedExecutable -Destination $destination -Force" in helper
    assert 'Resolve-LxeRipgrep -Version "15.1.0" -InstallIfMissing' in install
    assert 'Resolve-LxeRipgrep -Version "15.1.0" -InstallIfMissing' in update
    assert 'Resolve-LxeRipgrep -Version "15.1.0"' in doctor


def test_windows_desktop_runtime_preparer_is_pinned_isolated_and_offline_capable() -> None:
    script = _read(SCRIPTS / "prepare-desktop-runtime.ps1")
    runtime_lock = json.loads(
        _read(ROOT / "config" / "desktop-runtime" / "windows-x64" / "runtime.lock.json")
    )
    node_manifest = json.loads(
        _read(
            ROOT
            / "config"
            / "desktop-runtime"
            / "windows-x64"
            / "node"
            / "package.json"
        )
    )

    assert runtime_lock["platform"] == "win32-x64"
    assert runtime_lock["node"]["version"] == "22.22.2"
    assert runtime_lock["node"]["npm_version"] == "10.9.7"
    assert runtime_lock["python"]["version"] == "3.12.10"
    assert runtime_lock["uv"]["version"] == "0.11.19"
    assert runtime_lock["ripgrep"]["version"] == "15.1.0"
    assert runtime_lock["playwright"]["version"] == "1.58.0"
    assert runtime_lock["playwright"]["cache_key"] == "1.58.0-chromium-channel-no-shell"
    assert node_manifest["dependencies"] == {
        "@larksuite/cli": "1.0.58",
        "@larksuite/whiteboard-cli": "0.2.11",
        "dingtalk-workspace-cli": "1.0.50",
        "npm": "10.9.7",
    }
    assert "LXE_DESKTOP_RUNTIME_ROOT" in script
    assert "LXE_DESKTOP_CACHE_ROOT" in script
    assert 'elseif ($Offline)' in script
    assert 'throw "No complete runtime image is available for offline reconstruction' in script
    assert '"ci",' in script
    assert 'Copy-Item -LiteralPath $bootstrapNode' in script
    assert '"--break-system-packages"' in script
    assert 'Test-LxePathWithin -Candidate $stagedPython -Parent $Destination' in script
    assert '"export", "--frozen", "--no-dev", "--no-emit-project"' in script
    assert "PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT" in script
    assert '"--no-shell"' in script
    assert "channel='chromium'" in script
    assert "runtime-images" in script
    assert "Publish-LxeRuntime" in script


def test_windows_desktop_build_uses_managed_runtime_wrapper() -> None:
    package = json.loads(_read(ROOT / "package.json"))
    wrapper = _read(SCRIPTS / "build-desktop-windows.ps1")
    builder_config = _read(ROOT / "apps" / "desktop" / "electron-builder.yml")

    assert "validate:config" in package["scripts"]["desktop:validate:config"]
    assert "prepare-desktop-runtime.ps1" in package["scripts"]["desktop:runtime:win"]
    assert "build-desktop-windows.ps1" in package["scripts"]["desktop:dist:win"]
    assert "signingHashAlgorithms" not in builder_config
    assert wrapper.index("desktop:validate:config") < wrapper.index(
        "& $prepareScript @prepareParameters"
    )
    assert '"prepare-desktop-runtime.ps1"' in wrapper
    assert "desktop-runtime-inputs.json" in wrapper
    assert "Build-LxeDesktopProjectWheel" in wrapper
    assert '"build",' in wrapper
    assert '"--wheel",' in wrapper
    assert '$env:UV_CACHE_DIR = Join-Path $effectiveCacheRoot "uv-cache"' in wrapper
    assert '$env:UV_OFFLINE = if ($Offline) { "1" } else { "0" }' in wrapper
    assert "$env:LXE_DESKTOP_PROJECT_WHEEL = $wheels[0].FullName" in wrapper
    assert wrapper.index("    Build-LxeDesktopProjectWheel\n") < wrapper.index(
        'Invoke-LxeDesktopBuildStep -Label "Stage desktop resources"'
    )
    assert "Build frozen lxeskill" not in wrapper
    assert 'Invoke-LxeDesktopBuildStep -Label "Build NSIS installer"' in wrapper
    assert 'Invoke-LxeDesktopBuildStep -Label "Enforce desktop resource size budgets"' in wrapper
    assert '"desktop:sizes:win"' in wrapper
    assert "electronLanguages:" in builder_config
    assert "  - en-US" in builder_config
    assert "  - zh-CN" in builder_config


def test_desktop_resource_staging_installs_current_wheel_into_private_python() -> None:
    script = _read(SCRIPTS / "prepare-desktop-resources.ts")

    assert "LXE_DESKTOP_PROJECT_WHEEL" in script
    assert '"--break-system-packages"' in script
    assert '"--offline"' in script
    assert '"--no-deps"' in script
    assert '"--reinstall"' in script
    assert 'runSmoke("managed Python lxeskill"' in script
    assert ".lxe-lxeskill-ready.json" in script
    assert "wheel_sha256" in script
    assert '"-I"' in script
    assert 'join(outputRoot, "runtime", "lxeskill")' in script
    assert "copyDirectory(lxeskill" not in script
    assert "LXESKILL_BINARY_PATH" not in script
    assert "LXESKILL_REQUIRE_BUNDLE" not in script
    assert 'PLAYWRIGHT_NODEJS_PATH: join(stagedNodeRoot, "node.exe")' in script
    assert 'p.chromium.launch(channel=\'chromium\', headless=headless)' in script
    assert 'runSmoke("managed Python pip"' in script
    assert 'join(outputRoot, "runtime", "uv")' in script
    assert 'join(stagedNodeRoot, "npm-cache")' in script
    assert '["npm", "npm.cmd", "npm.ps1", "npx", "npx.cmd", "npx.ps1"]' in script
    assert 'join(stagedNodeRoot, "node_modules", "dingtalk-workspace-cli", "assets")' in script
    assert "Development-only runtime resource must not be packaged" in script


def test_desktop_size_report_enforces_runtime_and_unpacked_budgets() -> None:
    package = json.loads(_read(ROOT / "package.json"))
    script = _read(SCRIPTS / "report-desktop-resource-sizes.ts")

    assert package["scripts"]["desktop:sizes:win"] == (
        "bun scripts/report-desktop-resource-sizes.ts"
    )
    assert "DESKTOP_RUNTIME_BUDGET_BYTES = 950 * MIB" in script
    assert "DESKTOP_UNPACKED_BUDGET_BYTES = Math.floor(1.3 * GIB)" in script
    assert 'join(runtimeRoot, "node", "npm-cache")' in script
    assert 'join(runtimeRoot, "python", "Lib", "site-packages", "playwright")' in script
    assert 'join(runtimeRoot, "uv")' in script
    assert "assertDesktopResourceSizeBudgets(report)" in script


def test_packaged_desktop_reuses_managed_node_without_exposing_package_caches() -> None:
    gateway = _read(ROOT / "apps" / "desktop" / "src" / "main" / "desktop-gateway.ts")
    paths = _read(ROOT / "apps" / "desktop" / "src" / "main" / "paths.ts")

    assert "PLAYWRIGHT_NODEJS_PATH" in gateway
    assert 'join(process.resourcesPath, "runtime", "node", "node.exe")' in gateway
    assert "npm_config_prefix" not in gateway
    assert "npm_config_cache" not in gateway
    assert "npm_config_offline" not in gateway
    assert 'targetPath.join(options.resourcesPath, "runtime", "uv")' not in paths


def test_desktop_project_wheel_declares_full_python_business_closure() -> None:
    pyproject = tomllib.loads(_read(ROOT / "pyproject.toml"))

    assert pyproject["tool"]["hatch"]["build"]["targets"]["wheel"]["packages"] == [
        "python/lxeskill_cli/lxeskill",
        "python/lxeskill_cli/services",
        "python/lxeskill_cli/shared",
        "python/lxeskill_cli/browser_auth_service",
    ]
    assert "pyinstaller" not in {
        dependency.split("==", maxsplit=1)[0].lower()
        for dependency in pyproject["dependency-groups"]["dev"]
    }


def test_windows_doctor_runs_explicit_lxeskill_contract_check() -> None:
    doctor = _read(SCRIPTS / "doctor.ps1")

    assert 'Invoke-NativeChecked -Label "lxeskill Skill contract"' in doctor
    assert '-FilePath $projectPython' in doctor
    assert '"-I"' in doctor
    assert '"-m"' in doctor
    assert '"lxeskill"' in doctor
    assert '"doctor"' in doctor
    assert "PYTHONPATH" not in doctor
    assert "lxeskill-cli" not in doctor
    assert '"lxeskill command registry"' not in doctor


def test_windows_launcher_uses_isolated_project_python_for_lxeskill() -> None:
    launcher = _read(SCRIPTS / "launcher.ps1")

    assert r'Join-Path `$LxeRoot ".venv\Scripts\python.exe"' in launcher
    assert r'`$env:PYTHONNOUSERSITE = "1"' in launcher
    assert r'& `$PythonPath -I -m lxeskill @SkillArguments' in launcher
    assert "lxeskill-cli" not in launcher


def test_windows_resolver_prefers_exact_install_candidate_over_older_path() -> None:
    powershell = (
        os.environ.get("LXE_TEST_POWERSHELL")
        or shutil.which("pwsh")
        or shutil.which("powershell")
    )
    if not powershell:
        pytest.skip("PowerShell is required for the behavioral resolver test")

    helper_path = str(SCRIPTS / "_dependencies.ps1").replace("'", "''")
    behavior_probe = f"""
. '{helper_path}'

function Find-LxeBun {{
    return 'C:\\path-bun\\bun.exe'
}}

function Find-LxeBunCandidates {{
    return @('C:\\path-bun\\bun.exe', 'C:\\install-bun\\bun.exe')
}}

function Get-LxeBunVersion {{
    param([Parameter(Mandatory = $true)][string]$BunPath)
    if ($BunPath -eq 'C:\\install-bun\\bun.exe') {{
        return '1.3.14'
    }}
    return '1.2.0'
}}

$resolved = Resolve-Bun -Version '1.3.14'
if ($resolved -ne 'C:\\install-bun\\bun.exe') {{
    throw "Expected exact install candidate, got: $resolved"
}}
"""
    result = subprocess.run(
        [powershell, "-NoLogo", "-NoProfile", "-Command", behavior_probe],
        check=False,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stdout + result.stderr


@pytest.mark.parametrize(
    ("script_name", "mode"),
    [
        ("install.ps1", "-Build"),
        ("update.ps1", "-Build"),
        ("doctor.ps1", "-CheckOnly"),
    ],
)
def test_windows_maintenance_flows_delegate_dashboard_to_webui(
    script_name: str,
    mode: str,
) -> None:
    script = _read(SCRIPTS / script_name)

    assert '"scripts\\webui.ps1"' in script
    assert mode in script


def test_dashboard_readme_documents_pinned_root_bun_workflow() -> None:
    readme = _read(ROOT / "apps" / "dashboard" / "README.md")
    package = json.loads(_read(ROOT / "package.json"))

    assert package["packageManager"] == f"bun@{BUN_VERSION}"
    assert f"Bun {BUN_VERSION}" in readme
    assert "bun install --frozen-lockfile" in readme
    assert "bun run dashboard:build" in readme
    assert "package-lock.json" not in readme
    assert "npm " not in readme.lower()
