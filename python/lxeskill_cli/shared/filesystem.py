"""Keep Windows extended paths at the filesystem boundary, not in tool output."""
from __future__ import annotations

import os
from pathlib import Path


def filesystem_path(path: str | os.PathLike[str]) -> Path:
    path = Path(path).expanduser()
    if os.name != "nt":
        return path
    # Normalize relative components before opting out of Win32 path normalization.
    absolute = os.path.abspath(path)
    if absolute.startswith("\\\\?\\"):
        return Path(absolute)
    if absolute.startswith("\\\\"):
        return Path("\\\\?\\UNC\\" + absolute[2:])
    return Path("\\\\?\\" + absolute)


def display_path(path: str | os.PathLike[str]) -> Path:
    value = os.fspath(path)
    if os.name == "nt":
        if value[:8].lower() == "\\\\?\\unc\\":
            value = "\\\\" + value[8:]
        elif value.startswith("\\\\?\\") and len(value) > 6 and value[5:7] == ":\\":
            value = value[4:]
    return Path(value)
