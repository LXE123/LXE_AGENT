from __future__ import annotations

from collections.abc import Collection
from pathlib import Path

import yaml

from shared.logging import logger

from .skill_manifest import SkillManifest, SkillQueueItem, SkillReferenceManifest


SKILLS_ROOT = Path(__file__).resolve().parents[1] / "skills"
MAX_SKILL_QUEUE_SIZE = 150


def _split_front_matter(raw_text: str) -> tuple[dict, str]:
    normalized = raw_text.replace("\r\n", "\n")
    if not normalized.startswith("---\n"):
        raise RuntimeError("SKILL.md missing YAML front matter")
    end_marker = normalized.find("\n---\n", 4)
    if end_marker < 0:
        raise RuntimeError("SKILL.md front matter format invalid")
    front_matter = normalized[4:end_marker]
    body = normalized[end_marker + 5 :]
    try:
        data = yaml.safe_load(front_matter) or {}
    except Exception as error:
        raise RuntimeError("SKILL.md front matter format invalid") from error
    if not isinstance(data, dict):
        raise RuntimeError("SKILL.md front matter must be a mapping")
    return data, body.strip()


def _normalize_references(values: object) -> list[SkillReferenceManifest]:
    refs: list[SkillReferenceManifest] = []
    for entry in list(values or []):
        item = dict(entry or {})
        path = str(item.get("path") or "").strip().replace("\\", "/")
        description = str(item.get("description") or item.get("purpose") or "").strip()
        if path:
            refs.append(SkillReferenceManifest(path=path, description=description or path))
    return refs


def _resolve_path_within_skill(skill_dir: Path, relative_path: str) -> Path:
    skill_root = skill_dir.resolve()
    resolved = (skill_dir / str(relative_path or "").strip()).resolve()
    if skill_root not in resolved.parents and resolved != skill_root:
        raise RuntimeError(f"path escapes skill dir: {relative_path}")
    return resolved


class SkillIndex:
    def __init__(self, skills: dict[str, SkillManifest]) -> None:
        self._skills = skills

    def get(self, name: str) -> SkillManifest | None:
        return self._skills.get(str(name or "").strip())

    def all(self) -> list[SkillManifest]:
        return list(self._skills.values())

    def queue(
        self,
        *,
        limit: int = MAX_SKILL_QUEUE_SIZE,
        allowed_types: Collection[str] | None = None,
    ) -> list[SkillQueueItem]:
        safe_limit = max(0, int(limit or 0))
        safe_allowed_types = {str(item or "").strip() for item in list(allowed_types or []) if str(item or "").strip()}
        manifests = sorted(self._skills.values(), key=lambda item: item.name.casefold())
        if allowed_types is not None and "*" not in safe_allowed_types:
            manifests = [manifest for manifest in manifests if manifest.type in safe_allowed_types]
        return [
            SkillQueueItem(
                name=manifest.name,
                description=manifest.description,
                location=str((manifest.body_path or Path()).resolve()),
            )
            for manifest in manifests[:safe_limit]
        ]


_SKILL_INDEX: SkillIndex | None = None


def _load_skill(skill_dir: Path) -> SkillManifest:
    skill_path = skill_dir / "SKILL.md"
    raw_text = skill_path.read_text(encoding="utf-8")
    meta, _body = _split_front_matter(raw_text)
    name = str(meta.get("name") or "").strip()
    description = str(meta.get("description") or "").strip()
    skill_type = str(meta.get("type") or "").strip()
    if not name or not description or not skill_type:
        raise RuntimeError(f"{skill_path} missing name/description/type")
    manifest = SkillManifest(
        name=name,
        description=description,
        type=skill_type,
        references=_normalize_references(meta.get("references") or []),
        body_path=skill_path,
        root_dir=skill_dir,
    )
    seen_reference_paths: set[str] = set()
    for ref in manifest.references:
        if ref.path in seen_reference_paths:
            raise RuntimeError(f"{skill_path} duplicate reference path: {ref.path}")
        seen_reference_paths.add(ref.path)
        normalized_path = str(ref.path or "").replace("\\", "/")
        if not normalized_path.startswith("references/"):
            raise RuntimeError(f"{skill_path} invalid reference path outside references/: {ref.path}")
        resolved = _resolve_path_within_skill(skill_dir, ref.path)
        if not resolved.is_file():
            raise RuntimeError(f"{skill_path} missing reference file: {ref.path}")
    return manifest


def load_skill_index(*, force_reload: bool = False) -> SkillIndex:
    global _SKILL_INDEX
    if _SKILL_INDEX is not None and not force_reload:
        return _SKILL_INDEX

    skills: dict[str, SkillManifest] = {}
    skill_keys: dict[str, str] = {}
    if not SKILLS_ROOT.exists():
        raise RuntimeError(f"skills root not found: {SKILLS_ROOT}")

    for skill_path in sorted(SKILLS_ROOT.rglob("SKILL.md")):
        manifest = _load_skill(skill_path.parent)
        normalized_name = manifest.name.casefold()
        if normalized_name in skill_keys:
            raise RuntimeError(f"duplicate skill name: {manifest.name} conflicts with {skill_keys[normalized_name]}")
        skill_keys[normalized_name] = manifest.name
        skills[manifest.name] = manifest

    logger.info("[SkillIndex] loaded %s skills from %s", len(skills), SKILLS_ROOT)
    _SKILL_INDEX = SkillIndex(skills)
    return _SKILL_INDEX
