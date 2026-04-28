from __future__ import annotations

import re
from typing import Any

from .types import ApiMessageItem, ConvertContext, MentionInfo


_MENTION_OPEN_ID_RE = re.compile(r"open_id[:=]\s*([A-Za-z0-9_\-]+)")


def extract_mention_open_id(value: Any) -> str:
    if isinstance(value, str):
        match = _MENTION_OPEN_ID_RE.search(value)
        if match:
            return match.group(1).strip()
        return value.strip()
    if isinstance(value, dict):
        return str(value.get("open_id") or value.get("user_id") or "").strip()
    return ""


def build_convert_context_from_item(
    item: ApiMessageItem,
    fallback_message_id: str,
    *,
    account_id: str = "",
    bot_open_id: str = "",
    strip_bot_mentions: bool = False,
    include_resource_placeholders: bool = True,
) -> ConvertContext:
    mentions: dict[str, MentionInfo] = {}
    mentions_by_open_id: dict[str, MentionInfo] = {}
    for raw_mention in list(item.get("mentions") or []):
        if not isinstance(raw_mention, dict):
            continue
        open_id = extract_mention_open_id(raw_mention.get("id"))
        key = str(raw_mention.get("key") or "").strip()
        if not open_id or not key:
            continue
        info = MentionInfo(
            key=key,
            open_id=open_id,
            name=str(raw_mention.get("name") or "").strip(),
            is_bot=bool(bot_open_id and open_id == bot_open_id),
        )
        mentions[key] = info
        mentions_by_open_id[open_id] = info
    return ConvertContext(
        mentions=mentions,
        mentions_by_open_id=mentions_by_open_id,
        message_id=str(item.get("message_id") or fallback_message_id or "").strip(),
        item=item,
        account_id=account_id,
        bot_open_id=bot_open_id,
        strip_bot_mentions=strip_bot_mentions,
        include_resource_placeholders=include_resource_placeholders,
    )


def resolve_mentions(text: str, ctx: ConvertContext) -> str:
    result = str(text or "")
    if not result or not ctx.mentions:
        return result.strip()
    for key, info in ctx.mentions.items():
        if info.is_bot and ctx.strip_bot_mentions:
            if info.name:
                result = re.sub(rf"@{re.escape(info.name)}\s*", "", result)
            result = re.sub(rf"{re.escape(key)}\s*", "", result)
            continue
        replacement = f"@{info.name or info.open_id}"
        result = result.replace(key, replacement)
    return " ".join(result.split()).strip()


__all__ = [
    "build_convert_context_from_item",
    "extract_mention_open_id",
    "resolve_mentions",
]
