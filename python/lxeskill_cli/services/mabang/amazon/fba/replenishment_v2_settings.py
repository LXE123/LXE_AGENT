"""Persistent, user-editable seasonal settings for Amazon V2 replenishment."""
from __future__ import annotations

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


def _validate(raw: object) -> ReplenishmentV2Settings:
    if not isinstance(raw, dict) or type(raw.get("peak_boost_enabled")) is not bool:
        raise ValueError("peak_boost_enabled 必须是布尔值")
    if set(raw) != {"peak_boost_enabled", "peak_boost_days"}:
        raise ValueError("Amazon V2 旺季设置字段无效")
    days = raw.get("peak_boost_days")
    if days is not None and (type(days) is not int or not 0 <= days <= 120):
        raise ValueError("peak_boost_days 必须为空或 0～120 的整数")
    if raw["peak_boost_enabled"] and days is None:
        raise ValueError("启用旺季加成时必须填写加成天数（0～120的整数）")
    return {"peak_boost_enabled": raw["peak_boost_enabled"], "peak_boost_days": days}


def data_directory() -> Path:
    return state_root() / "skill-data" / "amazon-replenishment-v2"


def _path() -> Path:
    return data_directory() / "parameters.json"


def _read_unlocked() -> ReplenishmentV2Settings:
    path = _path()
    if not path.exists():
        return {"peak_boost_enabled": False, "peak_boost_days": None}
    if path.stat().st_size > 1024 * 1024:
        raise ValueError("Amazon V2 旺季设置文件超过 1 MiB")
    try:
        return _validate(json.loads(path.read_text(encoding="utf-8")))
    except ValueError as exc:
        raise ValueError(f"Amazon V2 旺季设置格式无效: {exc}") from exc


def _write_unlocked(parameters: ReplenishmentV2Settings) -> None:
    path = _path()
    temporary = path.with_name(f".{path.name}-{uuid4().hex}.tmp")
    try:
        with temporary.open("x", encoding="utf-8", newline="\n") as stream:
            stream.write(json.dumps(parameters, ensure_ascii=False, indent=2) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


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
