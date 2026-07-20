from __future__ import annotations

from collections import Counter
from pathlib import Path

from lxeskill.contract import validate_skill_command_contract


def _entry(command: str, owners: list[str], attribution: str = "") -> dict[str, object]:
    entry: dict[str, object] = {
        "command_path": command.split(),
        "visibility": "business",
        "owner_skills": owners,
    }
    if attribution:
        entry["attribution_skill"] = attribution
    return entry


def _write_skill(root: Path, name: str, frontmatter: str) -> Path:
    path = root / "skills" / name / "SKILL.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"---\n{frontmatter}\n---\n# {name}\n", encoding="utf-8")
    return path


def test_contract_collects_all_violations_and_reads_each_skill_once(tmp_path, monkeypatch) -> None:
    paths = [
        _write_skill(tmp_path, "alpha", "name: alpha\ncommands:\n  - lxeskill demo one"),
        _write_skill(tmp_path, "beta", "name: beta\ncommands:\n  - lxeskill demo one"),
        _write_skill(tmp_path, "gamma", "name: gamma\ncommands:\n  - lxeskill unknown run"),
        _write_skill(tmp_path, "broken", "name: broken\ncommands: ["),
    ]
    catalog = {
        "one": _entry("demo one", ["alpha", "missing-owner"], "alpha"),
        "two": _entry("demo two", ["alpha"]),
        "ownerless": _entry("demo ownerless", []),
    }

    real_read_text = Path.read_text
    reads: Counter[Path] = Counter()

    def counted_read_text(path: Path, *args, **kwargs) -> str:
        reads[path] += 1
        return real_read_text(path, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", counted_read_text)
    report = validate_skill_command_contract(catalog, skills_root=tmp_path / "skills")

    assert report.ok is False
    assert report.stats_payload() == {
        "catalog_commands": 3,
        "business_commands": 3,
        "skill_files": 4,
        "owner_skills": 2,
        "command_declarations": 3,
    }
    assert {violation.code for violation in report.violations} == {
        "skill_yaml_invalid",
        "catalog_owner_skill_missing",
        "catalog_command_owner_missing",
        "skill_command_duplicate_owner",
        "skill_command_owner_mismatch",
        "skill_command_unknown",
        "skill_command_missing",
    }
    assert all(not violation.path.startswith(str(tmp_path)) for violation in report.violations)
    assert {path: reads[path] for path in paths} == {path: 1 for path in paths}


def test_contract_accepts_legacy_scalar_command_and_ignores_non_lxeskill_commands(tmp_path) -> None:
    _write_skill(tmp_path, "alpha", "name: alpha\ncommand: lxeskill demo one")
    _write_skill(tmp_path, "unrelated", "name: unrelated\ncommands:\n  - dws docs get")

    report = validate_skill_command_contract(
        {"one": _entry("demo one", ["alpha"])},
        skills_root=tmp_path / "skills",
    )

    assert report.ok is True
    assert report.command_declarations == 1


def test_contract_read_failure_does_not_expose_an_absolute_path(tmp_path, monkeypatch) -> None:
    skill_path = _write_skill(tmp_path, "alpha", "name: alpha\ncommand: lxeskill demo one")
    real_read_text = Path.read_text

    def failed_read_text(path: Path, *args, **kwargs) -> str:
        if path == skill_path:
            raise PermissionError(f"denied: {path}")
        return real_read_text(path, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", failed_read_text)
    report = validate_skill_command_contract(
        {"one": _entry("demo one", ["alpha"])},
        skills_root=tmp_path / "skills",
    )

    assert report.violations[0].to_payload() == {
        "code": "skill_read_failed",
        "path": "skills/alpha/SKILL.md",
        "message": "Could not read Skill manifest (PermissionError)",
    }
    assert str(tmp_path) not in report.violations[0].message


def test_contract_supports_project_paths_with_chinese_and_spaces(tmp_path) -> None:
    project_root = tmp_path / "中文 project root"
    _write_skill(project_root, "alpha", "name: alpha\ncommand: lxeskill demo one")

    report = validate_skill_command_contract(
        {"one": _entry("demo one", ["alpha"])},
        skills_root=project_root / "skills",
    )

    assert report.ok is True
    assert report.skill_files == 1


def test_contract_requires_one_valid_attribution_for_multi_owner_commands(tmp_path) -> None:
    _write_skill(tmp_path, "alpha", "name: alpha\ncommand: lxeskill demo one")

    missing = validate_skill_command_contract(
        {"one": _entry("demo one", ["alpha", "beta"])},
        skills_root=tmp_path / "skills",
    )
    invalid = validate_skill_command_contract(
        {"one": _entry("demo one", ["alpha", "beta"], "gamma")},
        skills_root=tmp_path / "skills",
    )

    assert "catalog_attribution_missing" in {item.code for item in missing.violations}
    assert "catalog_attribution_not_owner" in {item.code for item in invalid.violations}
