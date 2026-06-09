from __future__ import annotations

import os
from pathlib import Path

from shared.env import load_project_env

load_project_env()


def env_text(name: str, default: str = "") -> str:
    return str(os.getenv(name, default) or default).strip()


def env_int(name: str, default: int, *, minimum: int | None = None) -> int:
    try:
        value = int(os.getenv(name, str(default)) or default)
    except Exception:
        value = int(default)
    if minimum is not None:
        return max(int(minimum), value)
    return value


def env_flag(name: str, default: bool) -> bool:
    raw = str(os.getenv(name, "1" if default else "0")).strip().lower()
    return raw not in {"0", "false", "no", "off", ""}


def env_path(name: str, default: str = "") -> str:
    value = env_text(name, default)
    if not value:
        return ""
    return str(Path(value).expanduser())


__all__ = ["env_flag", "env_int", "env_path", "env_text"]
