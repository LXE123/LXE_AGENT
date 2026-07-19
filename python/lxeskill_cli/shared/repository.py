from __future__ import annotations

import os
from pathlib import Path
from typing import Mapping


_REQUIRED_FILES = ("package.json", "pyproject.toml")
_REQUIRED_DIRECTORIES = ("config", "skills")


def _is_repository_root(candidate: Path) -> bool:
    return all((candidate / name).is_file() for name in _REQUIRED_FILES) and all(
        (candidate / name).is_dir() for name in _REQUIRED_DIRECTORIES
    )


def find_repository_root(
    start: str | Path | None = None,
    *,
    environment: Mapping[str, str] | None = None,
) -> Path:
    """Locate the checkout or packaged resource directory that owns CLI assets."""
    env = os.environ if environment is None else environment
    configured = str(env.get("LXE_ROOT") or "").strip()
    if configured:
        candidate = Path(configured).expanduser().resolve()
        if _is_repository_root(candidate):
            return candidate
        raise RuntimeError(f"LXE_ROOT is not an LXE repository root: {candidate}")

    origin = Path(start) if start is not None else Path(__file__)
    resolved = origin.expanduser().resolve()
    current = resolved if resolved.is_dir() else resolved.parent
    for candidate in (current, *current.parents):
        if _is_repository_root(candidate):
            return candidate
    raise RuntimeError(f"LXE repository root not found from: {resolved}")


_REPOSITORY_ROOT = find_repository_root()


def repository_root() -> Path:
    """Return the immutable root for bundled configuration, skills, and docs."""
    return _REPOSITORY_ROOT


def state_root(*, environment: Mapping[str, str] | None = None) -> Path:
    """Return the canonical writable ``var`` root."""
    env = os.environ if environment is None else environment
    configured = str(env.get("LXE_DATA_ROOT") or "").strip()
    return Path(configured).expanduser().resolve() if configured else (repository_root() / "var").resolve()


__all__ = ["find_repository_root", "repository_root", "state_root"]
