from __future__ import annotations

from collections.abc import Collection
from pathlib import Path

import yaml

from shared.logging import get_logger

from .skill_manifest import SkillManifest, SkillQueueItem, SkillReferenceManifest

logger = get_logger(__name__)


SKILLS_ROOT = Path(__file__).resolve().parents[1] / "skills"
EXTERNAL_SKILLS_ROOTS = (Path.home() / ".agents" / "skills",)
EXTERNAL_SKILL_DEFAULT_TYPE = "default"
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


def _normalize_commands(values: object) -> list[str]:
    commands: list[str] = []
    for entry in list(values or []):
        command = str(entry or "").strip()
        if command and command not in commands:
            commands.append(command)
    return commands


def _resolve_path_within_skill(skill_dir: Path, relative_path: str) -> Path:
    skill_root = skill_dir.resolve()
    resolved = (skill_dir / str(relative_path or "").strip()).resolve()
    if skill_root not in resolved.parents and resolved != skill_root:
        raise RuntimeError(f"path escapes skill dir: {relative_path}")
    return resolved


def is_external_skill_path_allowed(root: Path, candidate: Path) -> bool:
    """Return whether a path is under a configured external skill root."""
    try:
        resolved_root = Path(root).expanduser().resolve()
        resolved_candidate = Path(candidate).expanduser().resolve()
    except (OSError, TypeError):
        return False
    return resolved_candidate == resolved_root or resolved_candidate.is_relative_to(resolved_root)


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
_SKILL_INDEX_SIGNATURE: tuple[tuple[str, int, int], ...] | None = None


def _load_skill(skill_dir: Path, *, default_type: str = "") -> SkillManifest:
    skill_path = skill_dir / "SKILL.md"
    raw_text = skill_path.read_text(encoding="utf-8")
    meta, _body = _split_front_matter(raw_text)
    name = str(meta.get("name") or "").strip()
    description = str(meta.get("description") or "").strip()
    skill_type = str(meta.get("type") or default_type or "").strip()
    if not name or not description or not skill_type:
        raise RuntimeError(f"{skill_path} missing name/description/type")
    manifest = SkillManifest(
        name=name,
        description=description,
        type=skill_type,
        references=_normalize_references(meta.get("references") or []),
        commands=_normalize_commands(meta.get("commands") or []),
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


def _external_skill_roots() -> list[Path]:
    roots: list[Path] = []
    for root in list(EXTERNAL_SKILLS_ROOTS or ()):
        try:
            path = Path(root).expanduser()
        except TypeError:
            continue
        if path and path not in roots:
            roots.append(path)
    return roots


def _skill_source_roots() -> list[tuple[Path, str, str]]:
    roots: list[tuple[Path, str, str]] = [(SKILLS_ROOT, "", "repository")]
    for root in _external_skill_roots():
        roots.append((root, EXTERNAL_SKILL_DEFAULT_TYPE, "external"))
    return roots


def _iter_skill_paths(root: Path, *, source_kind: str) -> list[Path]:
    _ = source_kind
    return list(sorted(root.rglob("SKILL.md")))


def _skill_source_signature(
    source_roots: list[tuple[Path, str, str]],
) -> tuple[tuple[str, int, int], ...]:
    entries: list[tuple[str, int, int]] = []
    for root, _default_type, source_kind in source_roots:
        try:
            resolved_root = root.expanduser().resolve()
        except OSError:
            resolved_root = root.expanduser()
        root_key = f"{source_kind}:{resolved_root}"
        if not resolved_root.exists():
            entries.append((root_key, 0, 0))
            continue
        entries.append((root_key, 1, 0))
        for skill_path in _iter_skill_paths(resolved_root, source_kind=source_kind):
            try:
                stat = skill_path.stat()
            except OSError:
                continue
            entries.append((str(skill_path), stat.st_mtime_ns, stat.st_size))
    return tuple(entries)


def _add_manifest(
    *,
    manifest: SkillManifest,
    source_kind: str,
    skill_keys: dict[str, str],
    command_owners: dict[str, str],
    skills: dict[str, SkillManifest],
) -> None:
    normalized_name = manifest.name.casefold()
    if normalized_name in skill_keys:
        if source_kind == "external":
            logger.debug(
                "[SkillIndex] skipping external skill %s from %s because %s is already loaded",
                manifest.name,
                manifest.body_path,
                skill_keys[normalized_name],
            )
            return
        raise RuntimeError(f"duplicate skill name: {manifest.name} conflicts with {skill_keys[normalized_name]}")
    for command in manifest.commands:
        if command in command_owners:
            if source_kind == "external":
                logger.debug(
                    "[SkillIndex] skipping external skill %s from %s because command %s is owned by %s",
                    manifest.name,
                    manifest.body_path,
                    command,
                    command_owners[command],
                )
                return
            raise RuntimeError(
                f"duplicate skill command: {command} declared by both {command_owners[command]} and {manifest.name}"
            )
    for command in manifest.commands:
        command_owners[command] = manifest.name
    skill_keys[normalized_name] = manifest.name
    skills[manifest.name] = manifest


def load_skill_index(*, force_reload: bool = False) -> SkillIndex:
    global _SKILL_INDEX, _SKILL_INDEX_SIGNATURE
    source_roots = _skill_source_roots()
    signature = _skill_source_signature(source_roots)
    if _SKILL_INDEX is not None and not force_reload and signature == _SKILL_INDEX_SIGNATURE:
        return _SKILL_INDEX

    skills: dict[str, SkillManifest] = {}
    skill_keys: dict[str, str] = {}
    command_owners: dict[str, str] = {}
    if not SKILLS_ROOT.exists():
        raise RuntimeError(f"skills root not found: {SKILLS_ROOT}")

    loaded_roots: list[str] = []
    for root, default_type, source_kind in source_roots:
        if not root.exists():
            if source_kind == "external":
                continue
            raise RuntimeError(f"skills root not found: {root}")
        loaded_roots.append(str(root))
        for skill_path in _iter_skill_paths(root, source_kind=source_kind):
            manifest = _load_skill(skill_path.parent, default_type=default_type)
            _add_manifest(
                manifest=manifest,
                source_kind=source_kind,
                skill_keys=skill_keys,
                command_owners=command_owners,
                skills=skills,
            )

    logger.debug("[SkillIndex] loaded %s skills from %s", len(skills), ", ".join(loaded_roots))
    _SKILL_INDEX = SkillIndex(skills)
    _SKILL_INDEX_SIGNATURE = signature
    return _SKILL_INDEX
