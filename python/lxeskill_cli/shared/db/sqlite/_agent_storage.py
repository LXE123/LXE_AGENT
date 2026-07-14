from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any, Optional


_NULL_BYTE = "\x00"
_NULL_BYTE_ESCAPE = "\\u0000"


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def datetime_to_storage(value: datetime) -> str:
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat()


def datetime_from_storage(value: Any) -> Optional[datetime]:
    text = str(value or "").strip()
    if not text:
        return None
    return datetime.fromisoformat(text)


def sanitize_text_for_storage(value: Any) -> str:
    if value is None:
        return ""
    text = str(value)
    return text.replace(_NULL_BYTE, _NULL_BYTE_ESCAPE)


def sanitize_optional_text(value: Any, *, strip: bool = True) -> Optional[str]:
    if value is None:
        return None
    text = sanitize_text_for_storage(value)
    if strip:
        text = text.strip()
    return text or None


def sanitize_json_for_storage(value: Any) -> Any:
    if isinstance(value, str):
        return sanitize_text_for_storage(value)
    if isinstance(value, dict):
        return {
            sanitize_text_for_storage(key) if isinstance(key, str) else key: sanitize_json_for_storage(item)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [sanitize_json_for_storage(item) for item in value]
    if isinstance(value, tuple):
        return [sanitize_json_for_storage(item) for item in value]
    return value


def json_object_to_storage(value: Any, *, field_name: str) -> str:
    if value is None:
        cleaned: Any = {}
    else:
        cleaned = sanitize_json_for_storage(value)
    if not isinstance(cleaned, dict):
        raise RuntimeError(f"{field_name} must be a JSON object")
    return json.dumps(cleaned, ensure_ascii=False, separators=(",", ":"))


def json_object_from_storage(value: Any, *, field_name: str) -> dict[str, Any]:
    try:
        parsed = json.loads(str(value or "{}"))
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"invalid {field_name} JSON") from exc
    if not isinstance(parsed, dict):
        raise RuntimeError(f"{field_name} must be a JSON object")
    return parsed


def json_list_to_storage(value: Any, *, field_name: str) -> str:
    if value is None:
        cleaned: Any = []
    else:
        cleaned = sanitize_json_for_storage(value)
    if not isinstance(cleaned, list):
        raise RuntimeError(f"{field_name} must be a JSON list")
    return json.dumps(cleaned, ensure_ascii=False, separators=(",", ":"))


def json_list_from_storage(value: Any, *, field_name: str) -> list[Any]:
    try:
        parsed = json.loads(str(value or "[]"))
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"invalid {field_name} JSON") from exc
    if not isinstance(parsed, list):
        raise RuntimeError(f"{field_name} must be a JSON list")
    return parsed


__all__ = [
    "datetime_from_storage",
    "datetime_to_storage",
    "json_list_from_storage",
    "json_list_to_storage",
    "json_object_from_storage",
    "json_object_to_storage",
    "sanitize_json_for_storage",
    "sanitize_optional_text",
    "sanitize_text_for_storage",
    "utc_now",
]
