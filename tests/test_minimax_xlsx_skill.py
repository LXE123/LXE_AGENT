from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

from agent_runtime.skill_index import load_skill_index
from shared.permission_policy import SKILL_TYPE_DEFAULT


ROOT = Path(__file__).resolve().parents[1]
SKILL_DIR = ROOT / "skills" / "minimax-xlsx"
SKILL_MD = SKILL_DIR / "SKILL.md"


def test_minimax_xlsx_loads_as_default_skill() -> None:
    manifest = load_skill_index(force_reload=True).get("minimax-xlsx")

    assert manifest is not None
    assert manifest.type == SKILL_TYPE_DEFAULT
    assert manifest.body_path == SKILL_MD


def test_minimax_xlsx_declares_existing_references() -> None:
    manifest = load_skill_index(force_reload=True).get("minimax-xlsx")
    assert manifest is not None

    reference_paths = {reference.path for reference in manifest.references}
    assert reference_paths == {
        "references/read-analyze.md",
        "references/create.md",
        "references/edit.md",
        "references/fix.md",
        "references/validate.md",
        "references/format.md",
        "references/ooxml-cheatsheet.md",
    }

    for reference in manifest.references:
        assert reference.path.startswith("references/")
        resolved = (SKILL_DIR / reference.path).resolve()
        assert resolved.is_file()
        assert resolved.is_relative_to(SKILL_DIR.resolve())


def test_minimax_xlsx_description_protects_business_skills() -> None:
    manifest = load_skill_index(force_reload=True).get("minimax-xlsx")
    assert manifest is not None

    description = manifest.description
    assert "no more specific FBA or replenishment business skill applies" in description
    assert "Do not use for FBA shipment" in description
    assert "dedicated amazon_fba or amazon_replenish skill" in description


def test_minimax_xlsx_skill_uses_lxe_runtime_commands() -> None:
    text = SKILL_MD.read_text(encoding="utf-8")

    assert 'uv run --frozen python "$SKILL_DIR/scripts/' in text
    assert "artifacts/xlsx/" in text
    assert "artifacts/xlsx_work/<unique-task-name>/" in text
    assert "libreoffice_recalc.py` as optional Tier 2 validation" in text
    assert "python3 SKILL_DIR/scripts/" not in text
    assert "/tmp/xlsx_work" not in text


def test_minimax_xlsx_scripts_compile() -> None:
    scripts = sorted((SKILL_DIR / "scripts").glob("*.py"))
    assert scripts

    subprocess.run(
        [sys.executable, "-m", "py_compile", *[str(script) for script in scripts]],
        cwd=ROOT,
        check=True,
    )


def test_minimax_xlsx_pack_template_and_formula_check(tmp_path: Path) -> None:
    work_dir = tmp_path / "minimal_xlsx"
    output = tmp_path / "minimal.xlsx"
    shutil.copytree(SKILL_DIR / "templates" / "minimal_xlsx", work_dir)

    subprocess.run(
        [sys.executable, str(SKILL_DIR / "scripts" / "xlsx_pack.py"), str(work_dir), str(output)],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    )

    result = subprocess.run(
        [
            sys.executable,
            str(SKILL_DIR / "scripts" / "formula_check.py"),
            str(output),
            "--json",
        ],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    payload = json.loads(result.stdout)
    assert payload["error_count"] == 0


def test_minimax_xlsx_reader_handles_tiny_csv(tmp_path: Path) -> None:
    csv_path = tmp_path / "tiny.csv"
    csv_path.write_text("sku,quantity\nA001,2\nA002,3\n", encoding="utf-8")

    result = subprocess.run(
        [
            sys.executable,
            str(SKILL_DIR / "scripts" / "xlsx_reader.py"),
            str(csv_path),
            "--json",
        ],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    payload = json.loads(result.stdout)
    assert payload["structure"]["tiny"]["shape"] == {"rows": 2, "cols": 2}
    assert payload["stats"]["tiny"]["quantity"]["count"] == 2.0
    assert payload["stats"]["tiny"]["quantity"]["mean"] == 2.5
