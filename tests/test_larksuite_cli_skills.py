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
SKILL_ROOT = ROOT / "skills" / "larksuite-cli"
UPSTREAM = SKILL_ROOT / "UPSTREAM.md"

EXPECTED_LARK_SKILLS = {
    "lark-approval",
    "lark-apps",
    "lark-attendance",
    "lark-base",
    "lark-calendar",
    "lark-contact",
    "lark-doc",
    "lark-drive",
    "lark-event",
    "lark-im",
    "lark-mail",
    "lark-markdown",
    "lark-minutes",
    "lark-note",
    "lark-okr",
    "lark-openapi-explorer",
    "lark-shared",
    "lark-sheets",
    "lark-skill-maker",
    "lark-slides",
    "lark-task",
    "lark-vc",
    "lark-vc-agent",
    "lark-whiteboard",
    "lark-wiki",
    "lark-workflow-meeting-summary",
    "lark-workflow-standup-report",
}


def test_larksuite_cli_loads_official_skill_pack_as_default() -> None:
    index = load_skill_index(force_reload=True)

    loaded = {name for name in EXPECTED_LARK_SKILLS if index.get(name) is not None}
    assert loaded == EXPECTED_LARK_SKILLS

    for name in EXPECTED_LARK_SKILLS:
        manifest = index.get(name)
        assert manifest is not None
        assert manifest.type == SKILL_TYPE_DEFAULT
        assert manifest.body_path == SKILL_ROOT / name / "SKILL.md"


def test_larksuite_cli_declares_all_reference_files() -> None:
    index = load_skill_index(force_reload=True)

    for name in EXPECTED_LARK_SKILLS:
        manifest = index.get(name)
        assert manifest is not None
        skill_dir = SKILL_ROOT / name
        references_dir = skill_dir / "references"
        actual_paths = {
            path.relative_to(skill_dir).as_posix()
            for path in sorted(references_dir.rglob("*"))
            if path.is_file()
        } if references_dir.exists() else set()
        declared_paths = {reference.path for reference in manifest.references}

        assert declared_paths == actual_paths
        for reference in manifest.references:
            assert reference.path.startswith("references/")
            resolved = (skill_dir / reference.path).resolve()
            assert resolved.is_file()
            assert resolved.is_relative_to(skill_dir.resolve())


def test_larksuite_cli_preserves_upstream_provenance() -> None:
    text = UPSTREAM.read_text(encoding="utf-8")

    assert (SKILL_ROOT / "LICENSE").is_file()
    assert "larksuite/cli" in text
    assert "v1.0.57" in text
    assert "d11a6e97a4f291bb11546706a8419b5e16a140ff" in text
    assert "Source path: skills/" in text
    assert "@larksuite/cli 1.0.57" in text


def test_larksuite_cli_runtime_rules_are_declared() -> None:
    text = (SKILL_ROOT / "lark-shared" / "SKILL.md").read_text(encoding="utf-8")

    assert "command -v lark-cli" in text
    assert "lark-cli --version" in text
    assert "lark-cli auth status" in text
    assert 'uv run --frozen python "$SKILL_DIR/scripts/<script>.py"' in text
    assert "artifacts/lark/" in text
    assert "artifacts/lark_work/<unique-task-name>/" in text
    assert "confirmation_required" in text
    assert "--yes" in text
    assert "lark-cli schema" in text


def test_larksuite_cli_descriptions_protect_business_and_im_boundaries() -> None:
    index = load_skill_index(force_reload=True)
    lark_im = index.get("lark-im")
    feishu_im_read = index.get("feishu-im-read")

    assert lark_im is not None
    assert feishu_im_read is not None
    assert "Do not use as a replacement for FBA shipment" in lark_im.description
    assert "dedicated amazon_fba or amazon_replenish skill" in lark_im.description
    assert "prefer feishu-im-read" in lark_im.description
    assert "CLI-based sending, searching, cross-chat operations" in lark_im.description
    assert "只读消息查看" in feishu_im_read.description
    assert "不要用于发送消息、跨群搜索、群管理" in feishu_im_read.description


def test_larksuite_cli_python_scripts_compile(tmp_path: Path) -> None:
    scripts = sorted((SKILL_ROOT / "lark-slides" / "scripts").glob("*.py"))
    assert scripts

    subprocess.run(
        [sys.executable, "-m", "py_compile", *[str(script) for script in scripts]],
        cwd=ROOT,
        env={**os.environ, "PYTHONPYCACHEPREFIX": str(tmp_path / "pycache")},
        check=True,
    )


def test_larksuite_cli_optional_cli_smoke_when_available() -> None:
    if shutil.which("lark-cli") is None:
        pytest.skip("lark-cli is not installed on PATH")

    subprocess.run(
        ["lark-cli", "--version"],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    auth_status = subprocess.run(
        ["lark-cli", "auth", "status"],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    if auth_status.returncode != 0:
        pytest.skip("lark-cli is installed but not authenticated")
