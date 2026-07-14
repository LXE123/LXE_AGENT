from __future__ import annotations

import os
from pathlib import Path

from shared.repository import repository_root


_ENV_LOADED = False


def _project_root() -> Path:
    return repository_root()


def project_env_path(path: str | Path | None = None) -> Path:
    return Path(path) if path is not None else _project_root() / ".env"


def project_local_config_path(path: str | Path | None = None) -> Path:
    return Path(path) if path is not None else _project_root() / ".env.local"


def project_runtime_config_path(path: str | Path | None = None) -> Path:
    return Path(path) if path is not None else _project_root() / "config" / "runtime.env"


def _unquote_env_value(value: str) -> str:
    text = str(value or "").strip()
    if len(text) >= 2 and text[0] == text[-1] and text[0] in {'"', "'"}:
        text = text[1:-1]
        if value.strip().startswith('"'):
            text = text.replace(r"\n", "\n").replace(r"\r", "\r").replace(r"\t", "\t")
    return text


def _load_env_file(path: Path) -> None:
    if not path.exists():
        return

    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export ") :].strip()
        if "=" not in line:
            continue
        raw_name, raw_value = line.split("=", 1)
        name = raw_name.strip()
        if not _valid_env_name(name):
            continue
        if name in os.environ:
            continue
        os.environ[name] = _unquote_env_value(raw_value)


def load_project_env(
    path: str | Path | None = None,
    *,
    local_path: str | Path | None = None,
    runtime_path: str | Path | None = None,
) -> None:
    global _ENV_LOADED
    if _ENV_LOADED:
        return
    _ENV_LOADED = True

    env_path = project_env_path(path)
    resolved_local_path = (
        project_local_config_path(local_path)
        if local_path is not None or path is None
        else env_path.with_name(".env.local")
    )
    resolved_runtime_path = (
        project_runtime_config_path(runtime_path)
        if runtime_path is not None or path is None
        else env_path.parent / "config" / "runtime.env"
    )

    _load_env_file(env_path)
    _load_env_file(resolved_local_path)
    _load_env_file(resolved_runtime_path)


def _valid_env_name(name: str) -> bool:
    return bool(name) and name.replace("_", "").isalnum() and not name[0].isdigit()


__all__ = [
    "load_project_env",
    "project_env_path",
    "project_local_config_path",
    "project_runtime_config_path",
]
