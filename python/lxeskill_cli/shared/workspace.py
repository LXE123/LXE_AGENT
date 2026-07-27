from __future__ import annotations

import os
from pathlib import Path
from threading import RLock

from shared.logging import get_logger
from shared.repository import state_root


logger = get_logger(__name__)
_LOCK = RLock()
_workspace_root = Path(str(os.getenv("LXE_WORKSPACE_ROOT") or Path.cwd())).expanduser().resolve()
_internal_root = state_root() / "lxeskill"
_artifact_root = state_root() / "artifacts"


def _migrate_legacy_artifact_dirs(root: Path) -> None:
    """Rename pre-registry artifact directories into their registered layout.

    Idempotent: a legacy directory moves only when its target does not exist yet.
    When both exist the legacy one is left alone and reported, so that no data is
    silently merged.
    """
    from shared.datasets import load_datasets

    for entry in load_datasets().values():
        target = root / entry.dir
        for legacy_name in entry.legacy_dirs:
            legacy = root / legacy_name
            if not legacy.is_dir():
                continue
            if target.exists():
                logger.warning(
                    "artifact_dir_migration_skipped: %s and %s both exist", legacy, target
                )
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            legacy.rename(target)
            logger.info("artifact_dir_migrated: %s -> %s", legacy, target)


def activate_project_workspace() -> Path:
    """Use the selected business workspace with app-managed state under ``var``."""
    global _workspace_root, _internal_root, _artifact_root
    with _LOCK:
        configured_workspace = str(os.getenv("LXE_WORKSPACE_ROOT") or "").strip()
        _workspace_root = (
            Path(configured_workspace).expanduser().resolve()
            if configured_workspace
            else Path.cwd().resolve()
        )
        writable_root = state_root()
        _internal_root = writable_root / "lxeskill"
        _artifact_root = writable_root / "artifacts"
        _internal_root.mkdir(parents=True, exist_ok=True)
        _artifact_root.mkdir(parents=True, exist_ok=True)
        _migrate_legacy_artifact_dirs(_artifact_root)
    return _workspace_root


def activate_external_workspace(cwd: str | os.PathLike[str] | None = None) -> Path:
    """Use a private .lxeskill directory without changing the caller's Git config."""
    global _workspace_root, _internal_root, _artifact_root
    caller_root = Path(cwd or Path.cwd()).expanduser().resolve()
    internal_root = caller_root / ".lxeskill"
    internal_root.mkdir(parents=True, exist_ok=True)
    gitignore = internal_root / ".gitignore"
    if not gitignore.exists():
        gitignore.write_text("*\n", encoding="utf-8")
    with _LOCK:
        _workspace_root = caller_root
        _internal_root = internal_root
        _artifact_root = internal_root / "artifacts"
    logger.debug("Activated external lxeskill workspace: %s", internal_root)
    return internal_root


def workspace_root() -> Path:
    return _workspace_root


def internal_root() -> Path:
    return _internal_root


def artifact_root() -> Path:
    return _artifact_root


def artifact_path(*parts: str | os.PathLike[str]) -> Path:
    return _artifact_root.joinpath(*(Path(part) for part in parts))


def resolve_workspace_input(raw_path: str | os.PathLike[str]) -> Path:
    path = Path(raw_path).expanduser()
    return path.resolve() if path.is_absolute() else (_workspace_root / path).resolve()


__all__ = [
    "activate_external_workspace",
    "activate_project_workspace",
    "artifact_path",
    "artifact_root",
    "internal_root",
    "resolve_workspace_input",
    "workspace_root",
]
