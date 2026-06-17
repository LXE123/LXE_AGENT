from __future__ import annotations

import os
import re
from typing import Any


ToolStepStatus = str

_DETAIL_LIMIT = 240
_SECRET_NAME_RE = re.compile(
    r"token|secret|password|api[-_]?key|authorization|cookie|credential|bearer|session[-_]?id|client[-_]?secret|access[-_]?key",
    re.IGNORECASE,
)
_INLINE_ASSIGNMENT_RE = re.compile(r"(^|[\s\"'`])([A-Za-z_][A-Za-z0-9_]*)(=(?:\"[^\"]*\"|'[^']*'|[^\s\"'`]+))")
_AUTH_HEADER_RE = re.compile(r"(Authorization\s*:\s*(?:Bearer|Basic|Token)\s+)([^'\"\s]+)", re.IGNORECASE)
_SECRET_FLAG_RE = re.compile(r"((?:^|[\s\"'`]))(--?[A-Za-z0-9][A-Za-z0-9-]*)(=|\s+)(?:\"[^\"]*\"|'[^']*'|[^\s\"'`]+)")
_URL_SECRET_RE = re.compile(r"([?&])(api_key|token|secret|key|authorization|cookie)=[^&\s]*", re.IGNORECASE)
_UNIX_ABSOLUTE_PATH_RE = re.compile(r"(?<![\w.-])/(?:Users|home|var|tmp|private|Volumes|opt|usr)/[^\s\"'`,;:)]*")
_WINDOWS_ABSOLUTE_PATH_RE = re.compile(r"(?<![\w.-])[A-Za-z]:\\[^\s\"'`,;:)]*")


def build_tool_display_step(
    *,
    tool_call_id: str,
    tool_name: str,
    arguments: dict[str, Any] | None = None,
    status: ToolStepStatus = "running",
    duration_ms: int = 0,
) -> dict[str, Any]:
    safe_name = str(tool_name or "").strip() or "tool"
    descriptor = _descriptor_for_tool(safe_name)
    safe_status = str(status or "running").strip()
    if safe_status not in {"running", "success", "error"}:
        safe_status = "running"
    return {
        "id": str(tool_call_id or "").strip(),
        "name": safe_name,
        "title": descriptor["title"],
        "detail": _detail_for_tool(safe_name, dict(arguments or {}), descriptor),
        "status": safe_status,
        "duration_ms": max(0, int(duration_ms or 0)),
    }


def sanitize_tool_steps(raw_steps: Any) -> list[dict[str, Any]]:
    if not isinstance(raw_steps, list):
        return []
    steps: list[dict[str, Any]] = []
    for raw_step in raw_steps:
        if not isinstance(raw_step, dict):
            continue
        status = str(raw_step.get("status") or "running").strip()
        if status not in {"running", "success", "error"}:
            status = "running"
        step = {
            "id": str(raw_step.get("id") or "").strip(),
            "name": _clean_text(raw_step.get("name"), limit=80) or "tool",
            "title": _clean_text(raw_step.get("title"), limit=80) or "Tool",
            "detail": _sanitize_detail_text(raw_step.get("detail")),
            "status": status,
            "duration_ms": max(0, int(raw_step.get("duration_ms") or 0)),
        }
        steps.append(step)
    return steps


def _descriptor_for_tool(tool_name: str) -> dict[str, str]:
    normalized = tool_name.strip().lower()
    if normalized == "read":
        return {"title": "Read", "kind": "path", "key": "path"}
    if normalized == "write":
        return {"title": "Write", "kind": "path", "key": "file_path"}
    if normalized == "edit":
        return {"title": "Edit", "kind": "path", "key": "file_path"}
    if normalized == "ls":
        return {"title": "List files", "kind": "path", "key": "path"}
    if normalized == "send_file":
        return {"title": "Send file", "kind": "path", "key": "path"}
    if normalized == "exec":
        return {"title": "Run command", "kind": "command", "key": "command"}
    if normalized == "process":
        return {"title": "Process", "kind": "process", "key": "action"}
    if normalized == "feishu_im_bot_list_groups":
        return {"title": "List Feishu groups", "kind": "feishu", "key": "page_size"}
    if normalized == "feishu_im_bot_get_messages":
        return {"title": "Read Feishu messages", "kind": "feishu_messages", "key": "chat_id"}
    if normalized == "feishu_im_bot_get_thread_messages":
        return {"title": "Read Feishu thread", "kind": "feishu_thread", "key": "thread_id"}
    if normalized == "feishu_im_bot_fetch_resource":
        return {"title": "Fetch Feishu resource", "kind": "feishu_resource", "key": "type"}
    if normalized == "ziniao_browser":
        return {"title": "Ziniao browser", "kind": "ziniao", "key": "action"}
    if normalized == "ziniao_page":
        return {"title": "Ziniao page", "kind": "ziniao", "key": "action"}
    return {"title": _humanize_tool_name(tool_name), "kind": "generic", "key": ""}


def _detail_for_tool(tool_name: str, arguments: dict[str, Any], descriptor: dict[str, str]) -> str:
    kind = descriptor.get("kind") or "generic"
    key = descriptor.get("key") or ""
    if kind == "path":
        return _sanitize_path_detail(_scalar(arguments.get(key)) or ".")
    if kind == "command":
        return _sanitize_command_detail(_scalar(arguments.get(key)) or "command")
    if kind == "process":
        action = _scalar(arguments.get("action")) or "action"
        session = _scalar(arguments.get("session"))
        return _sanitize_detail_text(f"{action} {session}".strip())
    if kind == "feishu_messages":
        return _sanitize_detail_text(
            _first_nonempty(
                _scalar(arguments.get("relative_time")),
                _scalar(arguments.get("start_time")),
                _scalar(arguments.get("chat_id")),
                "current chat",
            )
        )
    if kind == "feishu_thread":
        return _sanitize_detail_text(_scalar(arguments.get("thread_id")) or "thread")
    if kind == "feishu_resource":
        resource_type = _scalar(arguments.get("type")) or "resource"
        message_id = _scalar(arguments.get("message_id"))
        return _sanitize_detail_text(f"{resource_type} {message_id}".strip())
    if kind == "feishu":
        page_size = _scalar(arguments.get("page_size"))
        return _sanitize_detail_text(f"page_size={page_size}" if page_size else "groups")
    if kind == "ziniao":
        action = _scalar(arguments.get("action")) or "action"
        store_id = _scalar(arguments.get("store_id"))
        return _sanitize_detail_text(f"{action} {store_id}".strip())
    for candidate_key in ("action", "path", "file_path", "command", "query", "url", "description", "target"):
        value = _scalar(arguments.get(candidate_key))
        if value:
            return _sanitize_detail_text(value)
    return ""


def _first_nonempty(*values: str | None) -> str:
    for value in values:
        if str(value or "").strip():
            return str(value or "").strip()
    return ""


def _scalar(value: Any) -> str:
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, (int, float, bool)):
        return str(value)
    return ""


def _humanize_tool_name(tool_name: str) -> str:
    words = [part for part in re.split(r"[_\-\s]+", str(tool_name or "").strip()) if part]
    if not words:
        return "Tool"
    return " ".join(word.capitalize() for word in words)


def _clean_text(value: Any, *, limit: int = _DETAIL_LIMIT) -> str:
    cleaned = " ".join(str(value or "").replace("\r\n", "\n").split())
    return _truncate(cleaned, limit)


def _sanitize_detail_text(value: Any) -> str:
    cleaned = _clean_text(value)
    if not cleaned:
        return ""
    cleaned = _redact_url_secrets(cleaned)
    cleaned = _redact_inline_secrets(cleaned)
    cleaned = _redact_absolute_paths(cleaned)
    return _truncate(cleaned, _DETAIL_LIMIT)


def _sanitize_path_detail(value: str) -> str:
    cleaned = _sanitize_detail_text(value)
    if not cleaned:
        return ""
    if os.path.isabs(cleaned):
        return f".../{os.path.basename(cleaned) or 'path'}"
    return cleaned


def _sanitize_command_detail(value: str) -> str:
    cleaned = _clean_text(value, limit=512)
    cleaned = _redact_url_secrets(cleaned)
    cleaned = _redact_inline_secrets(cleaned)
    cleaned = _redact_absolute_paths(cleaned)
    return _truncate(cleaned, _DETAIL_LIMIT)


def _redact_url_secrets(value: str) -> str:
    return _URL_SECRET_RE.sub(r"\1\2=[redacted]", value)


def _redact_inline_secrets(value: str) -> str:
    redacted = _INLINE_ASSIGNMENT_RE.sub(
        lambda match: f"{match.group(1)}{match.group(2)}=[redacted]"
        if _SECRET_NAME_RE.search(match.group(2))
        else match.group(0),
        value,
    )
    redacted = _AUTH_HEADER_RE.sub(r"\1[redacted]", redacted)

    def _flag_replacement(match: re.Match[str]) -> str:
        flag = match.group(2)
        separator = match.group(3)
        if not _SECRET_NAME_RE.search(flag):
            return match.group(0)
        return f"{match.group(1)}{flag}{separator}[redacted]"

    return _SECRET_FLAG_RE.sub(_flag_replacement, redacted)


def _redact_absolute_paths(value: str) -> str:
    def _unix_replacement(match: re.Match[str]) -> str:
        path = match.group(0)
        return f".../{os.path.basename(path) or 'path'}"

    def _windows_replacement(match: re.Match[str]) -> str:
        path = match.group(0)
        basename = re.split(r"[\\/]", path)[-1] or "path"
        return f".../{basename}"

    return _WINDOWS_ABSOLUTE_PATH_RE.sub(_windows_replacement, _UNIX_ABSOLUTE_PATH_RE.sub(_unix_replacement, value))


def _truncate(value: str, limit: int) -> str:
    if len(value) <= limit:
        return value
    return value[: max(0, limit - 3)] + "..."


__all__ = ["build_tool_display_step", "sanitize_tool_steps"]
