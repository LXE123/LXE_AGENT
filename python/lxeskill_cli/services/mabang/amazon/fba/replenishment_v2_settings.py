"""Persistent, user-editable seasonal settings for Amazon V2 replenishment."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import TypedDict
from uuid import uuid4

from shared.process_lock import interprocess_lock
from shared.repository import state_root


class ReplenishmentV2Settings(TypedDict):
    peak_boost_enabled: bool
    peak_boost_days: int | None


def _validate(raw: object, *, legacy: bool = False) -> ReplenishmentV2Settings:
    if not isinstance(raw, dict) or type(raw.get("peak_boost_enabled")) is not bool:
        raise ValueError("peak_boost_enabled 必须是布尔值")
    keys = set(raw)
    if keys != {"peak_boost_enabled", "peak_boost_days"} and not (legacy and keys == {"peak_boost_enabled"}):
        raise ValueError("Amazon V2 旺季设置字段无效")
    days = raw.get("peak_boost_days")
    if days is not None and (type(days) is not int or not 0 <= days <= 120):
        raise ValueError("peak_boost_days 必须为空或 0～120 的整数")
    if not legacy and raw["peak_boost_enabled"] and days is None:
        raise ValueError("启用旺季加成时必须填写加成天数（0～120的整数）")
    return {"peak_boost_enabled": raw["peak_boost_enabled"], "peak_boost_days": days}


def data_directory() -> Path:
    return state_root() / "skill-data" / "amazon-final-restock"


def _path() -> Path:
    return data_directory() / "parameters.json"


def _fingerprint(path: Path, contents: bytes) -> str:
    # A legacy save must invalidate opt-in even if it writes identical values.
    return hashlib.sha256(str(path.stat().st_mtime_ns).encode("ascii") + b"\0" + contents).hexdigest()


def _read_unlocked() -> ReplenishmentV2Settings:
    path = _path()
    if not path.exists():
        return {"peak_boost_enabled": False, "peak_boost_days": None}
    if path.stat().st_size > 1024 * 1024:
        raise ValueError("Amazon V2 旺季设置文件超过 1 MiB")
    contents = path.read_bytes()
    raw = json.loads(contents.decode("utf-8"))
    try:
        if isinstance(raw, dict) and "schema_version" in raw:
            if type(raw["schema_version"]) is not int or raw["schema_version"] != 2:
                raise ValueError("不支持的旺季加成配置版本")
            parameters = _validate({key: value for key, value in raw.items() if key != "schema_version"})
            # Convert the previous v2 format so a later downgrade can read it.
            _write_unlocked(parameters)
            return parameters
        parameters = _validate(raw, legacy=True)
        metadata_path = path.with_name("parameters.meta.json")
        if metadata_path.exists():
            if metadata_path.stat().st_size > 1024 * 1024:
                raise ValueError("旺季加成配置元数据超过 1 MiB")
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
            if not isinstance(metadata, dict) or set(metadata) != {"schema_version", "parameters_fingerprint"}:
                raise ValueError("旺季加成配置元数据字段无效")
            if type(metadata["schema_version"]) is not int or metadata["schema_version"] != 2:
                raise ValueError("不支持的旺季加成配置版本")
            fingerprint = metadata["parameters_fingerprint"]
            if (not isinstance(fingerprint, str) or len(fingerprint) != 64
                    or any(char not in "0123456789abcdef" for char in fingerprint)):
                raise ValueError("旺季加成配置元数据指纹无效")
            if fingerprint == _fingerprint(path, contents):
                return _validate(parameters)
        # Historical switches were preferences only, not permission to enable a run.
        # Missing/stale metadata means an old writer; keep days but require opt-in.
        return {**parameters, "peak_boost_enabled": False}
    except ValueError as exc:
        raise ValueError(f"Amazon V2 旺季设置格式无效: {exc}") from exc


def _replace_text(path: Path, text: str) -> None:
    temporary = path.with_name(f".{path.name}-{uuid4().hex}.tmp")
    try:
        with temporary.open("x", encoding="utf-8", newline="\n") as stream:
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _write_unlocked(parameters: ReplenishmentV2Settings) -> None:
    path = _path()
    contents = json.dumps(parameters, ensure_ascii=False, indent=2) + "\n"
    # Old and current settings readers share the existing lock. Publish matching
    # metadata last; an interrupted write leaves the new file without valid opt-in.
    _replace_text(path, contents)
    metadata = {"schema_version": 2, "parameters_fingerprint": _fingerprint(path, contents.encode("utf-8"))}
    _replace_text(path.with_name("parameters.meta.json"), json.dumps(metadata, ensure_ascii=False, indent=2) + "\n")


def read_state() -> ReplenishmentV2Settings:
    root = data_directory()
    root.mkdir(parents=True, exist_ok=True)
    with interprocess_lock(root / ".settings.lock"):
        parameters = _read_unlocked()
        if not _path().exists():
            _write_unlocked(parameters)
    return parameters


def save_parameters(raw: object) -> ReplenishmentV2Settings:
    parameters = _validate(raw)
    root = data_directory()
    root.mkdir(parents=True, exist_ok=True)
    with interprocess_lock(root / ".settings.lock"):
        _write_unlocked(parameters)
    return parameters
