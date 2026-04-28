from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from shared.logging import logger

from .api_client import api_client
from .converters import build_convert_context_from_item, convert_message_content, extract_mention_open_id
from .user_name_cache import get_user_name_cache


def _millis_string_to_datetime(value: str) -> str:
    try:
        millis = int(str(value or "").strip())
    except Exception:
        return ""
    dt = datetime.fromtimestamp(millis / 1000, tz=timezone.utc).astimezone(timezone(timedelta(hours=8)))
    return dt.isoformat(timespec="seconds")


def _sender_info(item: dict[str, Any]) -> tuple[str, str]:
    sender = item.get("sender") or {}
    if not isinstance(sender, dict):
        return "", "unknown"
    sender_id_raw = sender.get("id")
    if isinstance(sender_id_raw, dict):
        sender_id = str(
            sender_id_raw.get("open_id")
            or sender_id_raw.get("user_id")
            or sender.get("open_id")
            or ""
        ).strip()
    else:
        sender_id = str(sender_id_raw or sender.get("open_id") or "").strip()
    sender_type = str(sender.get("sender_type") or "unknown").strip() or "unknown"
    return sender_id, sender_type


async def _resolve_sender_names(items: list[dict[str, Any]], *, chat_id: str) -> dict[str, str]:
    cache = get_user_name_cache("feishu_bot")
    free_names: dict[str, str] = {}
    sender_ids: list[str] = []

    for item in items:
        sender = item.get("sender") or {}
        if isinstance(sender, dict):
            sender_id, _ = _sender_info(item)
            sender_name = str(sender.get("name") or "").strip()
            if sender_id and sender_name:
                free_names[sender_id] = sender_name
            if sender_id:
                sender_ids.append(sender_id)
        for mention in list(item.get("mentions") or []):
            if not isinstance(mention, dict):
                continue
            open_id = extract_mention_open_id(mention.get("id"))
            name = str(mention.get("name") or "").strip()
            if open_id and name:
                free_names[open_id] = name

    if free_names:
        cache.set_many(free_names)

    missing = [sender_id for sender_id in dict.fromkeys(sender_ids) if cache.get(sender_id) is None]
    if missing and chat_id:
        try:
            members = await api_client.list_chat_members(chat_id)
            member_names: dict[str, str] = {}
            for member in members:
                if not isinstance(member, dict):
                    continue
                member_id = str(member.get("member_id") or "").strip()
                member_name = str(member.get("name") or "").strip()
                if member_id and member_name:
                    member_names[member_id] = member_name
            if member_names:
                cache.set_many(member_names)
        except Exception as exc:
            logger.info("[FeishuHistory] list_chat_members failed: chat_id=%s error=%s", chat_id, exc)

    return {sender_id: cache.get(sender_id) or "" for sender_id in dict.fromkeys(sender_ids)}


async def format_message_item(
    item: dict[str, Any],
    *,
    name_resolver: dict[str, str] | None = None,
) -> dict[str, Any]:
    safe_item = dict(item or {})
    message_id = str(safe_item.get("message_id") or "").strip()
    msg_type = str(safe_item.get("msg_type") or "unknown").strip() or "unknown"
    raw_content = str(((safe_item.get("body") or {}) if isinstance(safe_item.get("body"), dict) else {}).get("content") or "")
    ctx = build_convert_context_from_item(
        safe_item,
        message_id,
        include_resource_placeholders=True,
    )
    ctx.resolve_user_name = (lambda open_id: str((name_resolver or {}).get(open_id) or "").strip() or None)
    ctx.batch_resolve_names = None
    ctx.fetch_sub_messages = api_client.get_message_items
    content = ""
    try:
        result = await convert_message_content(raw_content, msg_type, ctx)
        content = str(result.content or "").strip()
    except Exception as exc:
        logger.warning(
            "[FeishuHistory] converter failed, falling back to raw content: message_id=%s msg_type=%s error=%s",
            message_id,
            msg_type,
            exc,
        )
        content = raw_content

    sender_id, sender_type = _sender_info(safe_item)
    sender = safe_item.get("sender") or {}
    sender_name = ""
    if sender_id:
        sender_name = str((name_resolver or {}).get(sender_id) or "").strip()
    if not sender_name and isinstance(sender, dict):
        sender_name = str(sender.get("name") or "").strip()
    sender_payload: dict[str, str] = {
        "open_id": sender_id,
        "name": sender_name or sender_id,
    }
    mentions_payload = []
    for mention in list(safe_item.get("mentions") or []):
        if not isinstance(mention, dict):
            continue
        mentions_payload.append(
            {
                "key": str(mention.get("key") or "").strip(),
                "id": extract_mention_open_id(mention.get("id")),
                "name": str(mention.get("name") or "").strip(),
            }
        )

    payload: dict[str, Any] = {
        "message_id": message_id,
        "msg_type": msg_type,
        "content": content,
        "sender": sender_payload,
        "create_time": str(safe_item.get("create_time") or "").strip(),
        "create_time_iso": _millis_string_to_datetime(str(safe_item.get("create_time") or "").strip()),
        "thread_id": str(safe_item.get("thread_id") or "").strip(),
        "chat_id": str(safe_item.get("chat_id") or "").strip(),
    }
    if sender_type:
        payload["sender"]["sender_type"] = sender_type
    if mentions_payload:
        payload["mentions"] = mentions_payload
    if str(safe_item.get("thread_id") or "").strip():
        payload["thread_id"] = str(safe_item.get("thread_id") or "").strip()
    elif str(safe_item.get("parent_id") or "").strip():
        payload["reply_to"] = str(safe_item.get("parent_id") or "").strip()
    return payload


async def format_message_list(items: list[dict[str, Any]], *, chat_id: str) -> list[dict[str, Any]]:
    safe_items = [dict(item or {}) for item in list(items or [])]
    name_map = await _resolve_sender_names(safe_items, chat_id=str(chat_id or "").strip())
    return [await format_message_item(item, name_resolver=name_map) for item in safe_items]


__all__ = ["format_message_item", "format_message_list"]
