from __future__ import annotations

import os
from pathlib import Path


_ENV_LOADED = False


def _project_root() -> Path:
    return Path(__file__).resolve().parents[1]


def _unquote_env_value(value: str) -> str:
    text = str(value or "").strip()
    if len(text) >= 2 and text[0] == text[-1] and text[0] in {'"', "'"}:
        text = text[1:-1]
        if value.strip().startswith('"'):
            text = text.replace(r"\n", "\n").replace(r"\r", "\r").replace(r"\t", "\t")
    return text


def load_project_env(path: str | Path | None = None) -> None:
    global _ENV_LOADED
    if _ENV_LOADED:
        return
    _ENV_LOADED = True

    env_path = Path(path) if path is not None else _project_root() / ".env"
    if not env_path.exists():
        return

    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export ") :].strip()
        if "=" not in line:
            continue
        raw_name, raw_value = line.split("=", 1)
        name = raw_name.strip()
        if not name or not name.replace("_", "").isalnum() or name[0].isdigit():
            continue
        if name in os.environ:
            continue
        os.environ[name] = _unquote_env_value(raw_value)


__all__ = ["load_project_env"]
