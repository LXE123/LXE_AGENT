from __future__ import annotations

import json
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
    assert "https://bun.sh/install.ps1" in helper
    assert '@("-Version", $Version' in helper
    assert "$bunPath = Find-LxeBun -PreferInstallDirectory" in helper
    assert 'throw "Bun $Version is required' in helper
    assert 'throw "Bun installation finished, but Bun $Version is not available.' in helper


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
