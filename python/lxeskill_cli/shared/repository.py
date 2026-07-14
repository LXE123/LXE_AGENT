from __future__ import annotations

from pathlib import Path


_REQUIRED_FILES = ("package.json", "pyproject.toml")
_REQUIRED_DIRECTORIES = ("config", "skills")


def find_repository_root(start: str | Path | None = None) -> Path:
    """Locate the checkout that owns the editable LXE Skill CLI sources."""
    origin = Path(start) if start is not None else Path(__file__)
    resolved = origin.expanduser().resolve()
    current = resolved if resolved.is_dir() else resolved.parent
    for candidate in (current, *current.parents):
        if not all((candidate / name).is_file() for name in _REQUIRED_FILES):
            continue
        if all((candidate / name).is_dir() for name in _REQUIRED_DIRECTORIES):
            return candidate
    raise RuntimeError(f"LXE repository root not found from: {resolved}")


_REPOSITORY_ROOT = find_repository_root()


def repository_root() -> Path:
    """Return the immutable repository root for bundled assets and state."""
    return _REPOSITORY_ROOT


__all__ = ["find_repository_root", "repository_root"]
