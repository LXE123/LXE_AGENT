from __future__ import annotations

import json
import mimetypes
import re
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from agent_runtime.tool_executor import get_tool_context
from agent_runtime.types import ToolDefinition, ToolExecutionError, ToolResult, text_content_block
from platforms.feishu.api_client import DownloadedResource, api_client
from platforms.feishu.history_formatter import format_message_list
from shared.logging import logger


_FILENAME_SANITIZER = re.compile(r'[<>:"/\\|?*\x00-\x1f]+')
_TIME_UNITS_IN_SECONDS = {
    "minutes": 60,
    "hours": 3600,
    "days": 86400,
}


def _is_record(value: Any) -> bool:
    return isinstance(value, dict)


def _as_record(value: Any) -> dict[str, Any]:
    return dict(value) if isinstance(value, dict) else {}


def _workspace_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _artifacts_root() -> Path:
    return _workspace_root() / "artifacts" / "feishu" / "im_read"


def _feishu_msg_debug_root() -> Path:
    return _workspace_root() / "logs" / "feishu_msg"


def _tool_error(message: str) -> None:
    raise ToolExecutionError(str(message or "").strip())


def _json_tool_result(payload: dict[str, Any]) -> ToolResult:
    return ToolResult(
        content=[text_content_block(json.dumps(dict(payload or {}), ensure_ascii=False, indent=2))],
        details=dict(payload or {}),
    )


def _local_now() -> datetime:
    return datetime.now().astimezone()


def _localize_naive(value: datetime) -> datetime:
    return value if value.tzinfo is not None else value.replace(tzinfo=_local_now().tzinfo)


def _to_timestamp_seconds(value: datetime) -> str:
    return str(int(value.timestamp()))


def _month_start(value: datetime) -> datetime:
    return value.replace(day=1, hour=0, minute=0, second=0, microsecond=0)


def _period_end_inclusive(value: datetime) -> datetime:
    return value - timedelta(seconds=1)


def _parse_iso_to_seconds(value: str) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ToolExecutionError(f"无效时间格式: {text}") from exc
    return _to_timestamp_seconds(_localize_naive(parsed))


def _resolve_relative_time(relative_time: str) -> tuple[str, str]:
    text = str(relative_time or "").strip().lower()
    if not text:
        _tool_error("relative_time 不能为空")
    now = _local_now()
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    if text == "today":
        return _to_timestamp_seconds(today_start), _to_timestamp_seconds(now)
    if text == "yesterday":
        start = today_start - timedelta(days=1)
        end = _period_end_inclusive(today_start)
        return _to_timestamp_seconds(start), _to_timestamp_seconds(end)
    if text == "day_before_yesterday":
        start = today_start - timedelta(days=2)
        end = _period_end_inclusive(today_start - timedelta(days=1))
        return _to_timestamp_seconds(start), _to_timestamp_seconds(end)
    if text == "this_week":
        start = today_start - timedelta(days=today_start.weekday())
        return _to_timestamp_seconds(start), _to_timestamp_seconds(now)
    if text == "last_week":
        this_week_start = today_start - timedelta(days=today_start.weekday())
        start = this_week_start - timedelta(days=7)
        end = _period_end_inclusive(this_week_start)
        return _to_timestamp_seconds(start), _to_timestamp_seconds(end)
    if text == "this_month":
        start = _month_start(now)
        return _to_timestamp_seconds(start), _to_timestamp_seconds(now)
    if text == "last_month":
        this_month_start = _month_start(now)
        previous_month_anchor = this_month_start - timedelta(days=1)
        start = _month_start(previous_month_anchor)
        end = _period_end_inclusive(this_month_start)
        return _to_timestamp_seconds(start), _to_timestamp_seconds(end)
    match = re.fullmatch(r"last_(\d+)_(minutes|hours|days)", text)
    if not match:
        _tool_error(f"不支持的 relative_time: {relative_time}")
    count = int(match.group(1))
    unit = match.group(2)
    delta_seconds = count * _TIME_UNITS_IN_SECONDS[unit]
    start = now - timedelta(seconds=delta_seconds)
    return _to_timestamp_seconds(start), _to_timestamp_seconds(now)


def _resolve_time_range(
    *,
    relative_time: str = "",
    start_time: str = "",
    end_time: str = "",
) -> tuple[str, str]:
    if str(relative_time or "").strip() and (str(start_time or "").strip() or str(end_time or "").strip()):
        _tool_error("relative_time 和 start_time/end_time 不能同时使用")
    if str(relative_time or "").strip():
        return _resolve_relative_time(relative_time)
    return _parse_iso_to_seconds(start_time), _parse_iso_to_seconds(end_time)


def _validate_page_size(page_size: int, *, minimum: int, maximum: int, field_name: str = "page_size") -> int:
    try:
        value = int(page_size)
    except Exception as exc:
        raise ToolExecutionError(f"{field_name} 必须是整数") from exc
    if value < minimum or value > maximum:
        raise ToolExecutionError(f"{field_name} 必须在 {minimum}-{maximum} 之间")
    return value


def _validate_sort_rule(sort_rule: str) -> str:
    value = str(sort_rule or "create_time_desc").strip() or "create_time_desc"
    if value not in {"create_time_asc", "create_time_desc"}:
        _tool_error("sort_rule 只能是 create_time_asc 或 create_time_desc")
    return value


def _current_feishu_chat_id() -> str:
    ctx = get_tool_context()
    source = dict(getattr(ctx.session, "source", {}) or {})
    platform = str(source.get("platform") or "").strip().lower()
    if platform != "feishu":
        return ""
    return str(source.get("chat_id") or "").strip()


def _format_message_content(msg_type: str, raw_content: str) -> str:
    from platforms.feishu.converters import build_convert_context_from_item, convert_message_content_sync

    ctx = build_convert_context_from_item({}, "", include_resource_placeholders=True)
    ctx.fetch_sub_messages = api_client.get_message_items
    result = convert_message_content_sync(str(raw_content or ""), str(msg_type or ""), ctx)
    return str(result.content or "").strip()


def _sender_payload(item: dict[str, Any]) -> dict[str, str]:
    sender = _as_record(item.get("sender"))
    sender_id_raw = sender.get("id")
    if not _is_record(sender_id_raw):
        sender_id_raw = sender.get("sender_id")
    sender_id = _as_record(sender_id_raw)
    sender_id_text = str(
        sender.get("id")
        if isinstance(sender.get("id"), str)
        else sender.get("sender_id")
        if isinstance(sender.get("sender_id"), str)
        else ""
    ).strip()
    open_id = str(
        sender_id.get("open_id")
        or sender_id_text
        or sender.get("open_id")
        or item.get("sender_open_id")
        or ""
    ).strip()
    name = str(
        sender.get("name")
        or sender_id.get("name")
        or sender_id.get("user_id")
        or sender.get("user_id")
        or open_id
        or ""
    ).strip()
    return {
        "open_id": open_id,
        "name": name,
    }


def _format_message_item(item: dict[str, Any]) -> dict[str, Any]:
    safe_item = dict(item or {})
    message_id = str(safe_item.get("message_id") or "").strip()
    msg_type = str(safe_item.get("msg_type") or "unknown").strip() or "unknown"
    body = safe_item.get("body") or {}
    raw_content = str((body.get("content") if isinstance(body, dict) else "") or "")
    payload: dict[str, Any] = {
        "message_id": message_id,
        "msg_type": msg_type,
        "content": _format_message_content(msg_type, raw_content),
        "sender": _sender_payload(safe_item),
        "create_time": str(safe_item.get("create_time") or "").strip(),
        "thread_id": str(safe_item.get("thread_id") or "").strip(),
        "chat_id": str(safe_item.get("chat_id") or "").strip(),
    }
    if str(safe_item.get("parent_id") or "").strip():
        payload["reply_to"] = str(safe_item.get("parent_id") or "").strip()
    return payload


async def _format_message_item_async(item: dict[str, Any]) -> dict[str, Any]:
    return _format_message_item(item)


def _sanitize_filename(value: str, *, fallback: str) -> str:
    candidate = Path(str(value or "").strip()).name.strip()
    candidate = _FILENAME_SANITIZER.sub("_", candidate).strip().strip(".")
    return candidate or fallback


def _guess_extension(content_type: str) -> str:
    mime = str(content_type or "").split(";", 1)[0].strip().lower()
    guessed, _ = mimetypes.guess_type(f"file.{mime.split('/')[-1] if mime else ''}")
    if guessed:
        pass
    ext = mimetypes.guess_extension(mime) if mime else ""
    return str(ext or "")


def _reserve_file_path(directory: Path, file_name: str) -> Path:
    candidate = directory / file_name
    if not candidate.exists():
        return candidate
    stem = candidate.stem or "file"
    suffix = candidate.suffix
    index = 2
    while True:
        next_candidate = directory / f"{stem}_{index}{suffix}"
        if not next_candidate.exists():
            return next_candidate
        index += 1


def _dump_raw_messages(
    *,
    tool_name: str,
    chat_id: str,
    query: dict[str, Any],
    items: list[dict[str, Any]],
) -> str:
    now = _local_now()
    day_dir = _feishu_msg_debug_root() / now.strftime("%Y%m%d")
    day_dir.mkdir(parents=True, exist_ok=True)
    safe_chat_id = _sanitize_filename(chat_id, fallback="unknown_chat")
    file_name = f"{now.strftime('%H%M%S')}_{tool_name}_{safe_chat_id}.json"
    target_path = _reserve_file_path(day_dir, file_name)
    payload = {
        "tool": tool_name,
        "generated_at": now.isoformat(timespec="seconds"),
        "chat_id": chat_id,
        "query": dict(query or {}),
        "count": len(items),
        "messages": [
            {
                "message_id": str((item or {}).get("message_id") or "").strip(),
                "msg_type": str((item or {}).get("msg_type") or "").strip(),
                "create_time": str((item or {}).get("create_time") or "").strip(),
                "thread_id": str((item or {}).get("thread_id") or "").strip(),
                "parent_id": str((item or {}).get("parent_id") or "").strip(),
                "chat_id": str((item or {}).get("chat_id") or "").strip(),
                "sender": dict((item or {}).get("sender") or {}) if isinstance((item or {}).get("sender"), dict) else (item or {}).get("sender"),
                "mentions": list((item or {}).get("mentions") or []),
                "body_content": str((((item or {}).get("body") or {}) if isinstance((item or {}).get("body"), dict) else {}).get("content") or ""),
            }
            for item in list(items or [])
        ],
    }
    target_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    logger.info("[FeishuIMTools] raw message dump saved: path=%s", target_path)
    return str(target_path.resolve())


def _resolve_download_target(
    *,
    message_id: str,
    file_key: str,
    resource: DownloadedResource,
    resource_type: str,
) -> Path:
    directory = _artifacts_root() / str(message_id or "").strip()
    directory.mkdir(parents=True, exist_ok=True)
    ext = Path(str(resource.file_name or "").strip()).suffix or _guess_extension(resource.content_type)
    fallback = f"{resource_type}_{str(file_key or '').strip()}{ext}"
    safe_name = _sanitize_filename(resource.file_name, fallback=fallback)
    if not Path(safe_name).suffix and ext:
        safe_name = f"{safe_name}{ext}"
    return _reserve_file_path(directory, safe_name)


async def _handle_list_groups(
    page_size: int = 100,
    page_token: str = "",
    **_: Any,
) -> ToolResult:
    safe_page_size = _validate_page_size(page_size, minimum=1, maximum=100)
    data = await api_client.get_bot_groups(page_size=safe_page_size, page_token=page_token)
    groups = []
    for item in list(data.get("items") or []):
        group = dict(item or {})
        groups.append(
            {
                "chat_id": str(group.get("chat_id") or "").strip(),
                "name": str(group.get("name") or "").strip(),
                "chat_mode": str(group.get("chat_mode") or "").strip(),
                "chat_type": str(group.get("chat_type") or "").strip(),
                "description": str(group.get("description") or "").strip(),
                "member_count": int(group.get("member_count") or 0),
            }
        )
    payload = {
        "groups": groups,
        "has_more": bool(data.get("has_more")),
        "page_token": str(data.get("page_token") or "").strip(),
    }
    return _json_tool_result(payload)


async def _handle_get_messages(
    chat_id: str = "",
    relative_time: str = "",
    start_time: str = "",
    end_time: str = "",
    page_size: int = 50,
    page_token: str = "",
    sort_rule: str = "create_time_desc",
    debug_dump_raw: bool = False,
    **_: Any,
) -> ToolResult:
    safe_chat_id = str(chat_id or "").strip() or _current_feishu_chat_id()
    if not safe_chat_id:
        _tool_error("chat_id 不能为空；如果在当前飞书会话中调用，也可以省略让工具自动读取当前 chat_id")
    safe_page_size = _validate_page_size(page_size, minimum=1, maximum=50)
    safe_sort_rule = _validate_sort_rule(sort_rule)
    start_ts, end_ts = _resolve_time_range(
        relative_time=relative_time,
        start_time=start_time,
        end_time=end_time,
    )
    data = await api_client.get_chat_messages(
        safe_chat_id,
        start_time=start_ts,
        end_time=end_ts,
        page_size=safe_page_size,
        page_token=page_token,
        sort_rule=safe_sort_rule,
    )
    payload = {
        "chat_id": safe_chat_id,
        "messages": await format_message_list(list(data.get("items") or []), chat_id=safe_chat_id),
        "has_more": bool(data.get("has_more")),
        "page_token": str(data.get("page_token") or "").strip(),
    }
    if debug_dump_raw:
        payload["debug_dump_path"] = _dump_raw_messages(
            tool_name="feishu_im_bot_get_messages",
            chat_id=safe_chat_id,
            query={
                "relative_time": str(relative_time or "").strip(),
                "start_time": start_ts,
                "end_time": end_ts,
                "page_size": safe_page_size,
                "page_token": str(page_token or "").strip(),
                "sort_rule": safe_sort_rule,
            },
            items=list(data.get("items") or []),
        )
    return _json_tool_result(payload)


async def _handle_get_thread_messages(
    thread_id: str = "",
    page_size: int = 50,
    page_token: str = "",
    sort_rule: str = "create_time_desc",
    **_: Any,
) -> ToolResult:
    safe_thread_id = str(thread_id or "").strip()
    if not safe_thread_id:
        _tool_error("thread_id 不能为空")
    safe_page_size = _validate_page_size(page_size, minimum=1, maximum=50)
    safe_sort_rule = _validate_sort_rule(sort_rule)
    data = await api_client.get_thread_messages(
        safe_thread_id,
        page_size=safe_page_size,
        page_token=page_token,
        sort_rule=safe_sort_rule,
    )
    payload = {
        "thread_id": safe_thread_id,
        "messages": await format_message_list(list(data.get("items") or []), chat_id=""),
        "has_more": bool(data.get("has_more")),
        "page_token": str(data.get("page_token") or "").strip(),
    }
    return _json_tool_result(payload)


async def _handle_fetch_resource(
    message_id: str = "",
    file_key: str = "",
    type: str = "",
    **_: Any,
) -> ToolResult:
    safe_message_id = str(message_id or "").strip()
    safe_file_key = str(file_key or "").strip()
    safe_type = str(type or "").strip().lower()
    if not safe_message_id:
        _tool_error("message_id 不能为空")
    if not safe_file_key:
        _tool_error("file_key 不能为空")
    if safe_type not in {"image", "file"}:
        _tool_error("type 只能是 image 或 file")
    resource = await api_client.download_resource(
        message_id=safe_message_id,
        file_key=safe_file_key,
        resource_type=safe_type,
    )
    target_path = _resolve_download_target(
        message_id=safe_message_id,
        file_key=safe_file_key,
        resource=resource,
        resource_type=safe_type,
    )
    target_path.write_bytes(resource.data)
    payload = {
        "message_id": safe_message_id,
        "file_key": safe_file_key,
        "type": safe_type,
        "saved_path": str(target_path.resolve()),
        "content_type": str(resource.content_type or "").split(";", 1)[0].strip() or "application/octet-stream",
        "size_bytes": len(resource.data),
    }
    logger.info(
        "[FeishuIMTools] downloaded resource: message_id=%s file_key=%s saved_path=%s",
        safe_message_id,
        safe_file_key,
        payload["saved_path"],
    )
    return _json_tool_result(payload)


FEISHU_IM_BOT_LIST_GROUPS = ToolDefinition(
    name="feishu_im_bot_list_groups",
    description="List Feishu groups the bot can access. Use this when you need to find a chat_id by group name.",
    parameters={
        "type": "object",
        "properties": {
            "page_size": {
                "type": "integer",
                "description": "Number of groups to return per page (1-100). Default 100.",
                "minimum": 1,
                "maximum": 100,
            },
            "page_token": {
                "type": "string",
                "description": "Pagination token from the previous response.",
            },
        },
        "additionalProperties": False,
    },
    handler=_handle_list_groups,
)


FEISHU_IM_BOT_GET_MESSAGES = ToolDefinition(
    name="feishu_im_bot_get_messages",
    description=(
        "Read Feishu chat history with bot permissions. If chat_id is omitted in the current Feishu session, "
        "the tool uses the current chat automatically."
    ),
    parameters={
        "type": "object",
        "properties": {
            "chat_id": {
                "type": "string",
                "description": "Feishu chat_id (oc_xxx). Optional inside the current Feishu chat.",
            },
            "relative_time": {
                "type": "string",
                "description": "Relative time range such as today, yesterday, this_week, last_24_hours.",
            },
            "start_time": {
                "type": "string",
                "description": "ISO 8601 start time. Mutually exclusive with relative_time.",
            },
            "end_time": {
                "type": "string",
                "description": "ISO 8601 end time. Mutually exclusive with relative_time.",
            },
            "page_size": {
                "type": "integer",
                "description": "Number of messages to return (1-50). Default 50.",
                "minimum": 1,
                "maximum": 50,
            },
            "page_token": {
                "type": "string",
                "description": "Pagination token from the previous response.",
            },
            "sort_rule": {
                "type": "string",
                "enum": ["create_time_asc", "create_time_desc"],
                "description": "Sort by message creation time. Default create_time_desc.",
            },
            "debug_dump_raw": {
                "type": "boolean",
                "description": "When true, dump raw Feishu body.content and mentions to logs/feishu_msg for debugging mention/parser issues.",
            },
        },
        "additionalProperties": False,
    },
    handler=_handle_get_messages,
)


FEISHU_IM_BOT_GET_THREAD_MESSAGES = ToolDefinition(
    name="feishu_im_bot_get_thread_messages",
    description="Read Feishu thread replies with bot permissions.",
    parameters={
        "type": "object",
        "properties": {
            "thread_id": {
                "type": "string",
                "description": "Feishu thread id (omt_xxx).",
            },
            "page_size": {
                "type": "integer",
                "description": "Number of messages to return (1-50). Default 50.",
                "minimum": 1,
                "maximum": 50,
            },
            "page_token": {
                "type": "string",
                "description": "Pagination token from the previous response.",
            },
            "sort_rule": {
                "type": "string",
                "enum": ["create_time_asc", "create_time_desc"],
                "description": "Sort by message creation time. Default create_time_desc.",
            },
        },
        "required": ["thread_id"],
        "additionalProperties": False,
    },
    handler=_handle_get_thread_messages,
)


FEISHU_IM_BOT_FETCH_RESOURCE = ToolDefinition(
    name="feishu_im_bot_fetch_resource",
    description=(
        "Download a Feishu image or file resource from one message into the workspace artifacts directory."
        "\n\nImportant: message_id, file_key, and type must match."
        "\n- file_key must come from the resource inside that exact message_id"
        '\n- use type=\"image\" for image messages'
        '\n- use type=\"file\" for file, audio, and video messages'
        '\nIf the parameters do not match, Feishu returns \"File not in msg.\".'
    ),
    parameters={
        "type": "object",
        "properties": {
            "message_id": {
                "type": "string",
                "description": "Feishu message id (om_xxx). Extract it from the current context, for example from [message_id=om_xxx].",
            },
            "file_key": {
                "type": "string",
                "description": "Resource key from that exact message: image messages use image_key (img_xxx), file messages use file_key (file_xxx).",
            },
            "type": {
                "type": "string",
                "enum": ["image", "file"],
                "description": 'Resource type: "image" for image messages, "file" for file, audio, and video messages.',
            },
        },
        "required": ["message_id", "file_key", "type"],
        "additionalProperties": False,
    },
    handler=_handle_fetch_resource,
)


FEISHU_IM_TOOLS = (
    FEISHU_IM_BOT_LIST_GROUPS,
    FEISHU_IM_BOT_GET_MESSAGES,
    FEISHU_IM_BOT_GET_THREAD_MESSAGES,
    FEISHU_IM_BOT_FETCH_RESOURCE,
)


def register_feishu_im_tools(registry: Any) -> None:
    for tool in FEISHU_IM_TOOLS:
        if not registry.has(tool.name):
            registry.register(tool)
    logger.info(
        "[FeishuIMTools] registered %d tools: %s",
        len(FEISHU_IM_TOOLS),
        ", ".join(tool.name for tool in FEISHU_IM_TOOLS),
    )


__all__ = [
    "FEISHU_IM_BOT_FETCH_RESOURCE",
    "FEISHU_IM_BOT_GET_MESSAGES",
    "FEISHU_IM_BOT_GET_THREAD_MESSAGES",
    "FEISHU_IM_BOT_LIST_GROUPS",
    "FEISHU_IM_TOOLS",
    "_format_message_content",
    "_format_post_content",
    "_handle_fetch_resource",
    "_handle_get_messages",
    "_handle_get_thread_messages",
    "_handle_list_groups",
    "register_feishu_im_tools",
]
