from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import re
from typing import Any

import yaml

from shared.logging import get_logger


logger = get_logger(__name__)

_COMMAND_VISIBILITIES = {"business", "browser"}
_FRONTMATTER_PATTERN = re.compile(r"\A---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|\Z)")


@dataclass(frozen=True)
class SkillContractViolation:
    code: str
    path: str
    message: str

    def to_payload(self) -> dict[str, str]:
        return {"code": self.code, "path": self.path, "message": self.message}


@dataclass(frozen=True)
class SkillContractReport:
    catalog_commands: int
    business_commands: int
    skill_files: int
    owner_skills: int
    command_declarations: int
    violations: tuple[SkillContractViolation, ...]

    @property
    def ok(self) -> bool:
        return not self.violations

    def stats_payload(self) -> dict[str, int]:
        return {
            "catalog_commands": self.catalog_commands,
            "business_commands": self.business_commands,
            "skill_files": self.skill_files,
            "owner_skills": self.owner_skills,
            "command_declarations": self.command_declarations,
        }


def _command_text(entry: dict[str, Any]) -> str:
    return " ".join(str(item) for item in list(entry.get("command_path") or []))


def _relative_path(path: Path, project_root: Path) -> str:
    try:
        return path.relative_to(project_root).as_posix()
    except ValueError:
        return path.name


def _read_skill_commands(
    path: Path,
    project_root: Path,
) -> tuple[list[str], SkillContractViolation | None]:
    relative_path = _relative_path(path, project_root)
    try:
        content = path.read_text(encoding="utf-8")
    except OSError as exc:
        return [], SkillContractViolation(
            "skill_read_failed",
            relative_path,
            f"Could not read Skill manifest ({type(exc).__name__})",
        )

    match = _FRONTMATTER_PATTERN.match(content)
    if match is None:
        return [], SkillContractViolation(
            "skill_frontmatter_malformed",
            relative_path,
            "Skill manifest is missing valid YAML frontmatter",
        )
    try:
        metadata = yaml.safe_load(match.group(1)) or {}
    except yaml.YAMLError as exc:
        problem = getattr(exc, "problem", None)
        message = "Skill YAML frontmatter could not be parsed"
        if isinstance(problem, str) and problem.strip():
            message = f"{message}: {problem.strip()}"
        return [], SkillContractViolation("skill_yaml_invalid", relative_path, message)
    if not isinstance(metadata, dict):
        return [], SkillContractViolation(
            "skill_frontmatter_invalid",
            relative_path,
            "Skill YAML frontmatter must be an object",
        )

    raw_commands = metadata.get("commands", metadata.get("command", []))
    values = raw_commands if isinstance(raw_commands, list) else [raw_commands]
    commands = [str(item or "").strip() for item in values if str(item or "").strip()]
    return commands, None


def validate_skill_command_contract(
    catalog: dict[str, dict[str, Any]],
    *,
    project_root: Path,
) -> SkillContractReport:
    root = project_root.resolve()
    skills_root = root / "skills"
    skill_paths = sorted(skills_root.glob("**/SKILL.md"))
    violations: list[SkillContractViolation] = []
    parsed_commands: dict[str, set[str]] = {}
    invalid_skills: set[str] = set()
    command_declarations = 0

    for skill_path in skill_paths:
        skill_name = skill_path.parent.name
        commands, violation = _read_skill_commands(skill_path, root)
        if violation is not None:
            violations.append(violation)
            invalid_skills.add(skill_name)
            continue
        declared = {command for command in commands if command.startswith("lxeskill ")}
        parsed_commands.setdefault(skill_name, set()).update(declared)
        command_declarations += len(declared)

    command_entries: dict[str, dict[str, Any]] = {}
    canonical_owners: dict[str, str] = {}
    owner_skills: set[str] = set()
    business_commands = 0
    for entry in catalog.values():
        if str(entry.get("visibility") or "") not in _COMMAND_VISIBILITIES:
            continue
        business_commands += 1
        command = f"lxeskill {_command_text(entry)}"
        command_entries[command] = entry
        owners = [str(owner).strip() for owner in list(entry.get("owner_skills") or []) if str(owner).strip()]
        if not owners:
            violations.append(
                SkillContractViolation(
                    "catalog_command_owner_missing",
                    "py_tools/catalog.json",
                    f"Catalog command has no owner Skill: {command}",
                )
            )
            continue
        canonical_owners[command] = owners[0]
        owner_skills.update(owners)
        for owner in owners:
            owner_path = skills_root / owner / "SKILL.md"
            if not owner_path.is_file():
                violations.append(
                    SkillContractViolation(
                        "catalog_owner_skill_missing",
                        _relative_path(owner_path, root),
                        f"Catalog owner Skill does not exist: {owner}",
                    )
                )

    declared_owners: dict[str, str] = {}
    for skill_name, commands in parsed_commands.items():
        skill_path = skills_root / skill_name / "SKILL.md"
        relative_path = _relative_path(skill_path, root)
        for command in sorted(commands):
            existing_owner = declared_owners.get(command)
            if existing_owner is not None and existing_owner != skill_name:
                violations.append(
                    SkillContractViolation(
                        "skill_command_duplicate_owner",
                        relative_path,
                        f"Command is also declared by {existing_owner}: {command}",
                    )
                )
            else:
                declared_owners[command] = skill_name

            entry = command_entries.get(command)
            if entry is None:
                violations.append(
                    SkillContractViolation(
                        "skill_command_unknown",
                        relative_path,
                        f"Skill declares an unknown or non-business command: {command}",
                    )
                )
                continue
            expected_owner = canonical_owners.get(command)
            if expected_owner is not None and expected_owner != skill_name:
                violations.append(
                    SkillContractViolation(
                        "skill_command_owner_mismatch",
                        relative_path,
                        f"Command is owned by {expected_owner}, not {skill_name}: {command}",
                    )
                )

    for command, skill_name in canonical_owners.items():
        if skill_name in invalid_skills:
            continue
        skill_path = skills_root / skill_name / "SKILL.md"
        if not skill_path.is_file():
            continue
        if command not in parsed_commands.get(skill_name, set()):
            violations.append(
                SkillContractViolation(
                    "skill_command_missing",
                    _relative_path(skill_path, root),
                    f"Canonical owner does not declare catalog command: {command}",
                )
            )

    unique_violations = tuple(dict.fromkeys(violations))
    return SkillContractReport(
        catalog_commands=len(catalog),
        business_commands=business_commands,
        skill_files=len(skill_paths),
        owner_skills=len(owner_skills),
        command_declarations=command_declarations,
        violations=unique_violations,
    )
