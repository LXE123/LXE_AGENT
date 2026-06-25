from __future__ import annotations

import os
from pathlib import Path


_ENV_LOADED = False


def _project_root() -> Path:
    return Path(__file__).resolve().parents[1]


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


def _assignment_name(line: str) -> tuple[str, bool] | None:
    stripped = line.strip()
    if not stripped or stripped.startswith("#"):
        return None
    export_prefix = False
    if stripped.startswith("export "):
        stripped = stripped[len("export ") :].strip()
        export_prefix = True
    if "=" not in stripped:
        return None
    raw_name, _ = stripped.split("=", 1)
    name = raw_name.strip()
    if not _valid_env_name(name):
        return None
    return name, export_prefix


def _upsert_env_values(values: dict[str, str], path: Path) -> None:
    pending: dict[str, str] = {}
    for raw_name, raw_value in dict(values or {}).items():
        name = str(raw_name or "").strip()
        value = str(raw_value)
        if not _valid_env_name(name):
            raise ValueError(f"Invalid env name: {raw_name!r}")
        if "\n" in value or "\r" in value:
            raise ValueError(f"Invalid env value for {name}: newlines are not supported")
        pending[name] = value

    lines = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
    updated_lines: list[str] = []
    for line in lines:
        assignment = _assignment_name(line)
        if assignment is None:
            updated_lines.append(line)
            continue
        name, export_prefix = assignment
        if name not in pending:
            updated_lines.append(line)
            continue
        prefix = "export " if export_prefix else ""
        updated_lines.append(f"{prefix}{name}={pending.pop(name)}")

    for name, value in pending.items():
        updated_lines.append(f"{name}={value}")

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(updated_lines).rstrip("\n") + "\n", encoding="utf-8")


def upsert_project_env_values(values: dict[str, str], path: str | Path | None = None) -> None:
    _upsert_env_values(values, project_env_path(path))


def upsert_project_local_config_values(values: dict[str, str], path: str | Path | None = None) -> None:
    _upsert_env_values(values, project_local_config_path(path))


__all__ = [
    "load_project_env",
    "project_env_path",
    "project_local_config_path",
    "project_runtime_config_path",
    "upsert_project_env_values",
    "upsert_project_local_config_values",
]
