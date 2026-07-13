from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest


ROOT = Path(__file__).parents[1]
SCRIPTS = ROOT / "scripts"
BUN_VERSION = "1.3.14"


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


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


def test_windows_doctor_runs_explicit_lxeskill_contract_check() -> None:
    doctor = _read(SCRIPTS / "doctor.ps1")

    assert 'Invoke-NativeChecked -Label "lxeskill Skill contract"' in doctor
    assert '"py_tools.lxeskill"' in doctor
    assert '"doctor"' in doctor
    assert '"lxeskill command registry"' not in doctor


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
    readme = _read(ROOT / "web" / "agent-dashboard" / "README.md")
    package = json.loads(_read(ROOT / "package.json"))

    assert package["packageManager"] == f"bun@{BUN_VERSION}"
    assert f"Bun {BUN_VERSION}" in readme
    assert "bun install --frozen-lockfile" in readme
    assert "bun run dashboard:build" in readme
    assert "package-lock.json" not in readme
    assert "npm " not in readme.lower()
