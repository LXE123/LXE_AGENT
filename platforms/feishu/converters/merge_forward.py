from __future__ import annotations

from typing import Any

from .content_converter_helpers import build_convert_context_from_item
from .types import ApiMessageItem, ConvertContext, ConvertResult
from .utils import maybe_await


async def convert_merge_forward(_raw: str, ctx: ConvertContext) -> ConvertResult:
    if ctx.fetch_sub_messages is None:
        return ConvertResult(content="<forwarded_messages/>")
    content = await _expand(
        ctx.message_id,
        ctx.fetch_sub_messages,
        ctx.convert_message_content,
        ctx,
    )
    return ConvertResult(content=content)


async def _expand(
    root_message_id: str,
    fetch_sub_messages: Any,
    convert_content: Any,
    root_ctx: ConvertContext,
) -> str:
    try:
        items = list(await maybe_await(fetch_sub_messages(root_message_id)) or [])
    except Exception:
        return "<forwarded_messages/>"
    if not items:
        return "<forwarded_messages/>"

    children_map = _build_children_map(items, root_message_id)
    sender_ids = _collect_sender_ids(items, root_message_id)
    if sender_ids and root_ctx.batch_resolve_names is not None:
        try:
            await root_ctx.batch_resolve_names(sender_ids)
        except Exception:
            pass
    return await _format_sub_tree(root_message_id, children_map, convert_content, root_ctx)


def _build_children_map(items: list[ApiMessageItem], root_message_id: str) -> dict[str, list[ApiMessageItem]]:
    children_map: dict[str, list[ApiMessageItem]] = {}
    for item in items:
        message_id = str(item.get("message_id") or "").strip()
        upper_message_id = str(item.get("upper_message_id") or "").strip()
        if message_id == root_message_id and not upper_message_id:
            continue
        parent_id = upper_message_id or root_message_id
        children_map.setdefault(parent_id, []).append(dict(item or {}))
    for children in children_map.values():
        children.sort(key=lambda item: int(str(item.get("create_time") or "0") or 0))
    return children_map


def _collect_sender_ids(items: list[ApiMessageItem], root_message_id: str) -> list[str]:
    sender_ids: set[str] = set()
    for item in items:
        if str(item.get("message_id") or "").strip() == root_message_id and not str(item.get("upper_message_id") or "").strip():
            continue
        sender = item.get("sender") or {}
        if isinstance(sender, dict) and str(sender.get("sender_type") or "").strip() == "user":
            sender_id = str(sender.get("id") or "").strip()
            if sender_id:
                sender_ids.add(sender_id)
    return list(sender_ids)


async def _format_sub_tree(
    parent_id: str,
    children_map: dict[str, list[ApiMessageItem]],
    convert_content: Any,
    root_ctx: ConvertContext,
) -> str:
    children = list(children_map.get(parent_id) or [])
    if not children:
        return "<forwarded_messages/>"

    parts: list[str] = []
    for item in children:
        try:
            message_id = str(item.get("message_id") or "").strip()
            msg_type = str(item.get("msg_type") or "unknown").strip() or "unknown"
            create_time = _format_timestamp(item.get("create_time"))
            sender = item.get("sender") or {}
            sender_id = str(sender.get("id") or "unknown").strip() if isinstance(sender, dict) else "unknown"
            display_name = (
                root_ctx.resolve_user_name(sender_id)
                if root_ctx.resolve_user_name is not None
                else None
            ) or sender_id
            if msg_type == "merge_forward" and message_id:
                content = await _format_sub_tree(message_id, children_map, convert_content, root_ctx)
            else:
                raw_content = str(((item.get("body") or {}) if isinstance(item.get("body"), dict) else {}).get("content") or "")
                child_ctx = build_convert_context_from_item(
                    item,
                    parent_id,
                    account_id=root_ctx.account_id,
                    bot_open_id=root_ctx.bot_open_id,
                    strip_bot_mentions=root_ctx.strip_bot_mentions,
                    include_resource_placeholders=root_ctx.include_resource_placeholders,
                )
                child_ctx.resolve_user_name = root_ctx.resolve_user_name
                child_ctx.batch_resolve_names = root_ctx.batch_resolve_names
                child_ctx.fetch_sub_messages = root_ctx.fetch_sub_messages
                child_ctx.convert_message_content = convert_content
                result = await convert_content(raw_content, msg_type, child_ctx) if convert_content else ConvertResult(content=raw_content)
                content = str(result.content or "").strip() or "[empty]"
            parts.append(f"[{create_time}] {display_name}:\n{_indent_lines(content, '    ')}")
        except Exception:
            continue
    if not parts:
        return "<forwarded_messages/>"
    return f"<forwarded_messages>\n{'\n'.join(parts)}\n</forwarded_messages>"


def _format_timestamp(value: object) -> str:
    try:
        from .utils import millis_to_datetime

        formatted = millis_to_datetime(value or "")
        return formatted or "unknown"
    except Exception:
        return "unknown"


def _indent_lines(text: str, indent: str) -> str:
    return "\n".join(f"{indent}{line}" for line in str(text or "").splitlines())


__all__ = ["convert_merge_forward"]
