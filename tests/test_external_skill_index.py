from __future__ import annotations

from pathlib import Path

from agent_runtime import skill_index as skill_index_module
from agent_runtime.skill_index import load_skill_index


def _write_skill(
    root: Path,
    slug: str,
    *,
    name: str,
    description: str = "External skill fixture.",
    skill_type: str | None = None,
) -> Path:
    skill_dir = root / slug
    skill_dir.mkdir(parents=True)
    type_line = f"type: {skill_type}\n" if skill_type is not None else ""
    (skill_dir / "SKILL.md").write_text(
        f"""---
name: {name}
description: {description}
{type_line}---

# {name}
""",
        encoding="utf-8",
    )
    return skill_dir


def test_load_skill_index_loads_external_agent_skills_with_default_type(
    monkeypatch,
    tmp_path,
) -> None:
    repo_root = tmp_path / "repo-skills"
    external_root = tmp_path / "agent-skills"
    _write_skill(
        repo_root,
        "repo-skill",
        name="repo-skill",
        description="Repository skill fixture.",
        skill_type="repo_type",
    )
    external_skill_dir = _write_skill(
        external_root,
        "external-skill",
        name="external-skill",
        description="External skill fixture without a type.",
    )
    monkeypatch.setattr(skill_index_module, "SKILLS_ROOT", repo_root)
    monkeypatch.setattr(skill_index_module, "EXTERNAL_SKILLS_ROOTS", (external_root,), raising=False)
    monkeypatch.setattr(skill_index_module, "_SKILL_INDEX", None)

    index = load_skill_index(force_reload=True)

    manifest = index.get("external-skill")
    assert manifest is not None
    assert manifest.type == "default"
    assert manifest.body_path == external_skill_dir / "SKILL.md"


def test_load_skill_index_prefers_repository_skill_when_external_name_conflicts(
    monkeypatch,
    tmp_path,
) -> None:
    repo_root = tmp_path / "repo-skills"
    external_root = tmp_path / "agent-skills"
    repo_skill_dir = _write_skill(
        repo_root,
        "shared-name",
        name="shared-name",
        description="Repository copy.",
        skill_type="repo_type",
    )
    _write_skill(
        external_root,
        "shared-name",
        name="shared-name",
        description="External copy.",
    )
    monkeypatch.setattr(skill_index_module, "SKILLS_ROOT", repo_root)
    monkeypatch.setattr(skill_index_module, "EXTERNAL_SKILLS_ROOTS", (external_root,), raising=False)
    monkeypatch.setattr(skill_index_module, "_SKILL_INDEX", None)

    manifest = load_skill_index(force_reload=True).get("shared-name")

    assert manifest is not None
    assert manifest.type == "repo_type"
    assert manifest.body_path == repo_skill_dir / "SKILL.md"


def test_load_skill_index_refreshes_when_external_skill_is_installed_after_cache(
    monkeypatch,
    tmp_path,
) -> None:
    repo_root = tmp_path / "repo-skills"
    external_root = tmp_path / "agent-skills"
    _write_skill(
        repo_root,
        "repo-skill",
        name="repo-skill",
        description="Repository skill fixture.",
        skill_type="repo_type",
    )
    monkeypatch.setattr(skill_index_module, "SKILLS_ROOT", repo_root)
    monkeypatch.setattr(skill_index_module, "EXTERNAL_SKILLS_ROOTS", (external_root,), raising=False)
    monkeypatch.setattr(skill_index_module, "_SKILL_INDEX", None)

    assert load_skill_index(force_reload=True).get("new-external-skill") is None
    _write_skill(
        external_root,
        "new-external-skill",
        name="new-external-skill",
        description="Newly installed external skill.",
    )

    manifest = load_skill_index().get("new-external-skill")

    assert manifest is not None
    assert manifest.type == "default"
