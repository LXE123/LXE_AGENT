from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from inspect import isawaitable
from typing import Any


def safe_parse(raw: str) -> Any | None:
    text = str(raw or "").strip()
    if not text:
        return None
    try:
        return json.loads(text)
    except Exception:
        return None


def as_record(value: Any) -> dict[str, Any]:
    return dict(value) if isinstance(value, dict) else {}


def as_list(value: Any) -> list[Any]:
    return list(value) if isinstance(value, list) else []


def text_value(value: Any) -> str:
    return str(value or "").strip()


def join_non_empty(parts: list[str], *, sep: str = "\n") -> str:
    return sep.join(part for part in parts if str(part or "").strip()).strip()


def format_duration(seconds: int | float | str) -> str:
    try:
        total = max(0, int(float(seconds)))
    except Exception:
        return ""
    minutes, secs = divmod(total, 60)
    hours, minutes = divmod(minutes, 60)
    if hours:
        return f"{hours:d}:{minutes:02d}:{secs:02d}"
    return f"{minutes:d}:{secs:02d}"


def millis_to_datetime(value: str | int | float) -> str:
    try:
        raw = int(float(value))
    except Exception:
        return ""
    dt = datetime.fromtimestamp(raw / 1000, tz=timezone.utc).astimezone(timezone(timedelta(hours=8)))
    return dt.isoformat(timespec="seconds")


async def maybe_await(value: Any) -> Any:
    if isawaitable(value):
        return await value
    return value


__all__ = [
    "as_list",
    "as_record",
    "format_duration",
    "join_non_empty",
    "maybe_await",
    "millis_to_datetime",
    "safe_parse",
    "text_value",
]
