from __future__ import annotations

import os
from functools import lru_cache
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
    """Locate a source checkout. Published runtimes must use explicit resource paths."""
    del environment  # Retained only for source-call compatibility; generic roots are unsupported.
    origin = Path(start) if start is not None else Path(__file__)
    resolved = origin.expanduser().resolve()
    current = resolved if resolved.is_dir() else resolved.parent
    for candidate in (current, *current.parents):
        if _is_repository_root(candidate):
            return candidate
    raise RuntimeError(f"LXE repository root not found from: {resolved}")


@lru_cache(maxsize=1)
def repository_root() -> Path:
    """Return the source checkout root for development-only fallbacks."""
    return find_repository_root()


def skills_root(*, environment: Mapping[str, str] | None = None) -> Path:
    env = os.environ if environment is None else environment
    configured = str(env.get("LXE_SKILLS_ROOT") or "").strip()
    return Path(configured).expanduser().resolve() if configured else (repository_root() / "skills").resolve()


def runtime_env_path(*, environment: Mapping[str, str] | None = None) -> Path:
    env = os.environ if environment is None else environment
    configured = str(env.get("LXE_RUNTIME_ENV_PATH") or "").strip()
    return Path(configured).expanduser().resolve() if configured else (repository_root() / "config" / "runtime.env").resolve()


def state_root(*, environment: Mapping[str, str] | None = None) -> Path:
    """Return the canonical writable ``var`` root."""
    env = os.environ if environment is None else environment
    configured = str(env.get("LXE_DATA_ROOT") or "").strip()
    if configured:
        return Path(configured).expanduser().resolve()
    try:
        return (repository_root() / "var").resolve()
    except RuntimeError:
        return (Path.cwd() / "var").resolve()


__all__ = ["find_repository_root", "repository_root", "runtime_env_path", "skills_root", "state_root"]
