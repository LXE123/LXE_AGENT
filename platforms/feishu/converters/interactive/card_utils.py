from __future__ import annotations

from datetime import datetime, timedelta, timezone


def escape_attr(value: str) -> str:
    return (
        str(value or "")
        .replace("&", "&amp;")
        .replace('"', "&quot;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )


def format_milliseconds_to_iso8601(value: str | int | float) -> str:
    try:
        raw = int(float(value))
    except Exception:
        return ""
    dt = datetime.fromtimestamp(raw / 1000, tz=timezone.utc).astimezone(timezone(timedelta(hours=8)))
    return dt.isoformat(timespec="seconds")


def normalize_time_format(value: str) -> str:
    return str(value or "").strip().replace("T", " ")


__all__ = ["escape_attr", "format_milliseconds_to_iso8601", "normalize_time_format"]
