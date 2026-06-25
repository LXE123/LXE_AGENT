from __future__ import annotations

from typing import Any


def _clean_text(value: Any) -> str:
    return str(value or "").strip()


def _source_dict(source: Any) -> dict[str, Any]:
    if isinstance(source, dict):
        return dict(source)
    raw = getattr(source, "source", None)
    if isinstance(raw, dict):
        return dict(raw)
    return {}


def _source_extra(source: dict[str, Any]) -> dict[str, Any]:
    extra = source.get("extra")
    return dict(extra) if isinstance(extra, dict) else {}


def extract_source_bot_identity(source: Any) -> dict[str, str]:
    """Return normalized bot identity fields for agent data payloads."""
    source_data = _source_dict(source)
    platform = _clean_text(source_data.get("platform")).lower()
    bot_app_id = ""
    bot_id = ""
    bot_name = ""

    if platform == "feishu":
        extra = _source_extra(source_data)
        bot_app_id = _clean_text(extra.get("bot_app_id"))
        bot_id = _clean_text(extra.get("bot_id"))
        bot_name = _clean_text(extra.get("bot_name"))

    bot_display_name = bot_name or bot_id or bot_app_id
    return {
        "bot_app_id": bot_app_id,
        "bot_id": bot_id,
        "bot_name": bot_name,
        "bot_display_name": bot_display_name,
    }


__all__ = ["extract_source_bot_identity"]
