from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from agent_runtime.skill_index import load_skill_index
from shared.permission_policy import SKILL_TYPE_DEFAULT


ROOT = Path(__file__).resolve().parents[1]
SKILL_DIR = ROOT / "skills" / "dws"
SKILL_MD = SKILL_DIR / "SKILL.md"


def test_dws_loads_as_default_skill() -> None:
    manifest = load_skill_index(force_reload=True).get("dws")

    assert manifest is not None
    assert manifest.type == SKILL_TYPE_DEFAULT
    assert manifest.body_path == SKILL_MD


def test_dws_declares_all_reference_files() -> None:
    manifest = load_skill_index(force_reload=True).get("dws")
    assert manifest is not None

    declared_paths = {reference.path for reference in manifest.references}
    actual_paths = {
        path.relative_to(SKILL_DIR).as_posix()
        for path in sorted((SKILL_DIR / "references").rglob("*.md"))
    }
    assert declared_paths == actual_paths

    for reference in manifest.references:
        assert reference.path.startswith("references/")
        resolved = (SKILL_DIR / reference.path).resolve()
        assert resolved.is_file()
        assert resolved.is_relative_to(SKILL_DIR.resolve())


def test_dws_preserves_upstream_provenance() -> None:
    text = SKILL_MD.read_text(encoding="utf-8")

    assert (SKILL_DIR / "LICENSE").is_file()
    assert (SKILL_DIR / "NOTICE").is_file()
    assert "DingTalk-Real-AI/dingtalk-workspace-cli" in text
    assert "release `v1.0.39`" in text
    assert "tag commit `91f44a1efddcfb3356f29c19810a245c08f3c104`" in text
    assert "source path `skills/mono`" in text


def test_dws_description_protects_business_skills() -> None:
    manifest = load_skill_index(force_reload=True).get("dws")
    assert manifest is not None

    description = manifest.description
    assert "Do not use as a replacement for FBA shipment" in description
    assert "replenishment workflow requests" in description
    assert "dedicated amazon_fba or amazon_replenish skill" in description


def test_dws_skill_uses_lxe_runtime_rules() -> None:
    text = SKILL_MD.read_text(encoding="utf-8")

    assert "command -v dws" in text
    assert "dws --version" in text
    assert "dws auth status" in text
    assert 'uv run --frozen python "$SKILL_DIR/scripts/<script>.py"' in text
    assert "artifacts/dws/" in text
    assert "artifacts/dws_work/<unique-task-name>/" in text
    assert "--format json" in text


def test_dws_scripts_compile(tmp_path: Path) -> None:
    scripts = sorted((SKILL_DIR / "scripts").glob("*.py"))
    assert scripts

    subprocess.run(
        [sys.executable, "-m", "py_compile", *[str(script) for script in scripts]],
        cwd=ROOT,
        env={**os.environ, "PYTHONPYCACHEPREFIX": str(tmp_path / "pycache")},
        check=True,
    )


def test_dws_optional_cli_smoke_when_available() -> None:
    if shutil.which("dws") is None:
        pytest.skip("dws is not installed on PATH")

    subprocess.run(
        ["dws", "--version"],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    auth_status = subprocess.run(
        ["dws", "auth", "status"],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    if auth_status.returncode != 0:
        pytest.skip("dws is installed but not authenticated")
