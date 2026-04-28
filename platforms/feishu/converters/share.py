from __future__ import annotations

from .types import ConvertContext, ConvertResult
from .utils import safe_parse, text_value


def convert_share_chat(raw: str, _ctx: ConvertContext) -> ConvertResult:
    parsed = safe_parse(raw)
    chat_id = text_value(parsed.get("chat_id")) if isinstance(parsed, dict) else ""
    return ConvertResult(content=f"<group_card id=\"{chat_id}\"/>")


def convert_share_user(raw: str, _ctx: ConvertContext) -> ConvertResult:
    parsed = safe_parse(raw)
    user_id = text_value(parsed.get("user_id")) if isinstance(parsed, dict) else ""
    return ConvertResult(content=f"<contact_card id=\"{user_id}\"/>")


__all__ = ["convert_share_chat", "convert_share_user"]
