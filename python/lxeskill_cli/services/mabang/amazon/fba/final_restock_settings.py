"""Persistent, user-editable settings for the Amazon final-restock workbook."""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import TypedDict
from uuid import uuid4

from shared.process_lock import interprocess_lock
from shared.repository import state_root


class FinalRestockSettings(TypedDict):
    peak_boost_enabled: bool
    peak_boost_days: int | None


def _validate(raw: object, *, legacy: bool = False) -> FinalRestockSettings:
    if not isinstance(raw, dict) or type(raw.get("peak_boost_enabled")) is not bool:
        raise ValueError("peak_boost_enabled 必须是布尔值")
    keys = set(raw)
    if keys != {"peak_boost_enabled", "peak_boost_days"} and not (legacy and keys == {"peak_boost_enabled"}):
        raise ValueError("Amazon 最终备货设置字段无效")
    days = raw.get("peak_boost_days")
    if days is not None and (type(days) is not int or not 0 <= days <= 120):
        raise ValueError("peak_boost_days 必须为空或 0～120 的整数")
    return {"peak_boost_enabled": raw["peak_boost_enabled"], "peak_boost_days": days}


def data_directory() -> Path:
    return state_root() / "skill-data" / "amazon-final-restock"


def _path() -> Path:
    return data_directory() / "parameters.json"


def _read_unlocked() -> FinalRestockSettings:
    path = _path()
    if not path.exists():
        return {"peak_boost_enabled": False, "peak_boost_days": None}
    if path.stat().st_size > 1024 * 1024:
        raise ValueError("Amazon 最终备货设置文件超过 1 MiB")
    raw = json.loads(path.read_text(encoding="utf-8"))
    try:
        return _validate(raw, legacy=True)
    except ValueError as exc:
        raise ValueError(f"Amazon 最终备货设置格式无效: {exc}") from exc


def _write_unlocked(parameters: FinalRestockSettings) -> None:
    root = data_directory()
    temporary = root / f".parameters-{uuid4().hex}.tmp"
    try:
        with temporary.open("x", encoding="utf-8") as stream:
            json.dump(parameters, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, _path())
    finally:
        temporary.unlink(missing_ok=True)


def read_state() -> FinalRestockSettings:
    root = data_directory()
    root.mkdir(parents=True, exist_ok=True)
    with interprocess_lock(root / ".settings.lock"):
        parameters = _read_unlocked()
        if not _path().exists():
            _write_unlocked(parameters)
    return parameters


def save_parameters(raw: object) -> FinalRestockSettings:
    parameters = _validate(raw)
    root = data_directory()
    root.mkdir(parents=True, exist_ok=True)
    with interprocess_lock(root / ".settings.lock"):
        _write_unlocked(parameters)
    return parameters
