"""Parse Feishu message content into plain text and resource descriptors."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .converters import build_convert_context_from_item, convert_message_content, convert_message_content_sync
from .converters.content_converter_helpers import extract_mention_open_id
from .converters.types import ConvertContext, ResourceDescriptor


@dataclass(slots=True)
class InboundResource:
    type: str
    file_key: str
    file_name: str = ""


@dataclass(slots=True)
class ParsedMessageContent:
    text: str = ""
    resources: list[InboundResource] = field(default_factory=list)


def _normalize_resource_type(resource_type: str) -> str:
    safe_type = str(resource_type or "").strip().lower()
    if safe_type in {"audio", "video"}:
        return "file"
    return safe_type


def _adapt_resources(resources: list[ResourceDescriptor] | None) -> list[InboundResource]:
    adapted: list[InboundResource] = []
    for resource in list(resources or []):
        file_key = str(getattr(resource, "file_key", "") or "").strip()
        if not file_key:
            continue
        adapted.append(
            InboundResource(
                type=_normalize_resource_type(str(getattr(resource, "type", "") or "").strip()),
                file_key=file_key,
                file_name=str(getattr(resource, "file_name", "") or "").strip(),
            )
        )
    return adapted


def _build_context(
    *,
    message_id: str,
    mentions: list[dict[str, Any]] | None,
    bot_open_id: str,
    strip_bot_mentions: bool,
    include_resource_placeholders: bool,
) -> ConvertContext:
    item = {
        "message_id": str(message_id or "").strip(),
        "mentions": list(mentions or []),
    }
    return build_convert_context_from_item(
        item,
        str(message_id or "").strip(),
        bot_open_id=str(bot_open_id or "").strip(),
        strip_bot_mentions=strip_bot_mentions,
        include_resource_placeholders=include_resource_placeholders,
    )


async def parse_message_payload_async(
    message_type: str,
    raw_content: str,
    *,
    message_id: str = "",
    mentions: list[dict[str, Any]] | None = None,
    bot_open_id: str = "",
    strip_bot_mentions: bool = False,
    include_resource_placeholders: bool = False,
    fetch_sub_messages: Any | None = None,
) -> ParsedMessageContent:
    ctx = _build_context(
        message_id=message_id,
        mentions=mentions,
        bot_open_id=bot_open_id,
        strip_bot_mentions=strip_bot_mentions,
        include_resource_placeholders=include_resource_placeholders,
    )
    ctx.fetch_sub_messages = fetch_sub_messages
    result = await convert_message_content(str(raw_content or ""), str(message_type or ""), ctx)
    return ParsedMessageContent(
        text=str(result.content or "").strip(),
        resources=_adapt_resources(result.resources),
    )


def parse_message_payload(
    message_type: str,
    raw_content: str,
    *,
    message_id: str = "",
    mentions: list[dict[str, Any]] | None = None,
    bot_open_id: str = "",
    strip_bot_mentions: bool = False,
    include_resource_placeholders: bool = False,
    fetch_sub_messages: Any | None = None,
) -> ParsedMessageContent:
    ctx = _build_context(
        message_id=message_id,
        mentions=mentions,
        bot_open_id=bot_open_id,
        strip_bot_mentions=strip_bot_mentions,
        include_resource_placeholders=include_resource_placeholders,
    )
    ctx.fetch_sub_messages = fetch_sub_messages
    result = convert_message_content_sync(str(raw_content or ""), str(message_type or ""), ctx)
    return ParsedMessageContent(
        text=str(result.content or "").strip(),
        resources=_adapt_resources(result.resources),
    )


async def parse_message_content_async(
    message_type: str,
    raw_content: str,
    *,
    message_id: str = "",
    mentions: list[dict[str, Any]] | None = None,
    bot_open_id: str = "",
    strip_bot_mentions: bool = False,
    include_resource_placeholders: bool = False,
    fetch_sub_messages: Any | None = None,
) -> str:
    parsed = await parse_message_payload_async(
        message_type,
        raw_content,
        message_id=message_id,
        mentions=mentions,
        bot_open_id=bot_open_id,
        strip_bot_mentions=strip_bot_mentions,
        include_resource_placeholders=include_resource_placeholders,
        fetch_sub_messages=fetch_sub_messages,
    )
    return parsed.text


def parse_message_content(
    message_type: str,
    raw_content: str,
    *,
    message_id: str = "",
    mentions: list[dict[str, Any]] | None = None,
    bot_open_id: str = "",
    strip_bot_mentions: bool = False,
    include_resource_placeholders: bool = False,
    fetch_sub_messages: Any | None = None,
) -> str:
    return parse_message_payload(
        message_type,
        raw_content,
        message_id=message_id,
        mentions=mentions,
        bot_open_id=bot_open_id,
        strip_bot_mentions=strip_bot_mentions,
        include_resource_placeholders=include_resource_placeholders,
        fetch_sub_messages=fetch_sub_messages,
    ).text


def is_bot_mentioned(mentions: list[dict[str, Any]] | None, bot_open_id: str) -> bool:
    safe_bot_open_id = str(bot_open_id or "").strip()
    if not safe_bot_open_id:
        return False
    for mention in list(mentions or []):
        if not isinstance(mention, dict):
            continue
        if extract_mention_open_id(mention.get("id")) == safe_bot_open_id:
            return True
    return False


def strip_bot_mention(text: str, mentions: list[dict[str, Any]] | None, bot_open_id: str) -> str:
    cleaned = str(text or "")
    safe_bot_open_id = str(bot_open_id or "").strip()
    if not cleaned or not safe_bot_open_id:
        return cleaned.strip()
    for mention in list(mentions or []):
        if not isinstance(mention, dict):
            continue
        if extract_mention_open_id(mention.get("id")) != safe_bot_open_id:
            continue
        name = str(mention.get("name") or "").strip()
        key = str(mention.get("key") or "").strip()
        if name:
            cleaned = cleaned.replace(f"@{name}", " ")
        if key:
            cleaned = cleaned.replace(key, " ")
    return " ".join(cleaned.split()).strip()


__all__ = [
    "InboundResource",
    "ParsedMessageContent",
    "is_bot_mentioned",
    "parse_message_content",
    "parse_message_content_async",
    "parse_message_payload",
    "parse_message_payload_async",
    "strip_bot_mention",
]
