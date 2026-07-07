from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

from shared.agent_state import MESSAGES_KEY, context_state, update_context_state
from shared.logging import get_logger

from ._agent_storage import sanitize_json_for_storage
from .engine import database_path
from .session_messages import _clean_session_id, load_session_messages, session_messages_path

logger = get_logger(__name__)

_IMAGE_OMITTED_PLACEHOLDER = "[image omitted from transcript]"
_REPLACEMENT_KINDS = {
    "compaction",
    "context_reset",
    "memory_clear",
    "legacy_import",
    "repair",
    "history_limit",
}


def session_transcripts_dir() -> Path:
    return database_path().parent / "session_transcripts"


def session_transcript_path(session_id: str) -> Path:
    return session_transcripts_dir() / f"{_clean_session_id(session_id)}.jsonl"


def _now_ts() -> float:
    return time.time()


def _clean_messages(messages: Any) -> list[dict[str, Any]]:
    state = update_context_state({}, {MESSAGES_KEY: list(messages or [])})
    return list(context_state(state).get(MESSAGES_KEY) or [])


def _strip_image_block(block: dict[str, Any]) -> dict[str, Any]:
    next_block = dict(block or {})
    if str(next_block.get("type") or "").strip() != "image":
        return next_block
    source = dict(next_block.get("source") or {})
    media_type = str(source.get("media_type") or source.get("mimeType") or "").strip()
    text = (
        f"[image omitted from transcript: {media_type}]"
        if media_type
        else _IMAGE_OMITTED_PLACEHOLDER
    )
    return {"type": "text", "text": text}


def _strip_inline_images(content: Any) -> Any:
    if not isinstance(content, list):
        return content
    return [
        _strip_image_block(dict(block or {}) if isinstance(block, dict) else {})
        for block in list(content or [])
    ]


def _strip_message_images(message: dict[str, Any]) -> dict[str, Any]:
    next_message = dict(message or {})
    role = str(next_message.get("role") or "").strip()
    content = next_message.get("content")
    if role == "user":
        next_message["content"] = _strip_inline_images(content)
        return next_message
    if role != "tool" or not isinstance(content, list):
        return next_message

    next_blocks: list[dict[str, Any]] = []
    for raw_block in list(content or []):
        block = dict(raw_block or {}) if isinstance(raw_block, dict) else {}
        if str(block.get("type") or "").strip() == "tool_result":
            block["content"] = _strip_inline_images(block.get("content"))
        next_blocks.append(block)
    next_message["content"] = next_blocks
    return next_message


def _clean_transcript_messages(messages: Any) -> list[dict[str, Any]]:
    return [_strip_message_images(message) for message in _clean_messages(messages)]


def _append_event(session_id: str, event: dict[str, Any]) -> dict[str, Any]:
    safe_session_id = _clean_session_id(session_id)
    target_dir = session_transcripts_dir()
    target_dir.mkdir(parents=True, exist_ok=True)
    target_path = target_dir / f"{safe_session_id}.jsonl"
    payload = sanitize_json_for_storage(event)
    with target_path.open("a", encoding="utf-8", newline="\n") as handle:
        handle.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
        handle.write("\n")
    return payload


def load_transcript_events(session_id: str) -> list[dict[str, Any]]:
    path = session_transcript_path(session_id)
    if not path.is_file():
        return []

    events: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line_number, raw_line in enumerate(handle, start=1):
            line = raw_line.strip()
            if not line:
                continue
            try:
                parsed = json.loads(line)
            except json.JSONDecodeError as exc:
                raise RuntimeError(
                    f"invalid session transcript JSONL: path={path} line={line_number}"
                ) from exc
            if isinstance(parsed, dict):
                events.append(parsed)
    return events


def append_transcript_message(
    session_id: str,
    message: dict[str, Any] | None,
    *,
    reason: str = "",
) -> dict[str, Any] | None:
    cleaned = _clean_transcript_messages([dict(message or {})])
    if not cleaned:
        return None
    event = {
        "ts": _now_ts(),
        "kind": "message",
        "reason": str(reason or "").strip(),
        "message": cleaned[0],
    }
    return _append_event(session_id, event)


def append_transcript_replacement(
    session_id: str,
    *,
    replacement_history: list[dict[str, Any]] | None,
    replacement_kind: str,
    reason: str = "",
    summary_text: str = "",
    compacted_count: int = 0,
    trigger: str = "",
) -> dict[str, Any]:
    safe_kind = str(replacement_kind or "").strip()
    if safe_kind not in _REPLACEMENT_KINDS:
        raise RuntimeError(f"invalid transcript replacement kind: {safe_kind!r}")
    event: dict[str, Any] = {
        "ts": _now_ts(),
        "kind": safe_kind,
        "replacement_kind": safe_kind,
        "reason": str(reason or "").strip(),
        "replacement_history": _clean_transcript_messages(replacement_history or []),
    }
    if safe_kind == "compaction":
        event.update(
            {
                "summary_text": str(summary_text or "").strip(),
                "compacted_count": max(0, int(compacted_count or 0)),
                "trigger": str(trigger or "").strip(),
            }
        )
    return _append_event(session_id, event)


def _replacement_kind_from_event(event: dict[str, Any]) -> str:
    kind = str(event.get("kind") or "").strip()
    if kind == "replacement":
        return str(event.get("replacement_kind") or "").strip()
    if kind in _REPLACEMENT_KINDS:
        return kind
    return ""


def _transcript_file_has_content(session_id: str) -> bool:
    path = session_transcript_path(session_id)
    if not path.is_file():
        return False
    with path.open("r", encoding="utf-8") as handle:
        return any(bool(line.strip()) for line in handle)


def ensure_transcript_seeded_from_legacy_messages(session_id: str) -> bool:
    if _transcript_file_has_content(session_id):
        return False
    if not session_messages_path(session_id).is_file():
        return False
    append_transcript_replacement(
        session_id,
        replacement_history=load_session_messages(session_id),
        replacement_kind="legacy_import",
        reason="legacy_session_messages_import",
    )
    return True


def replay_transcript_model_context(session_id: str) -> list[dict[str, Any]]:
    events = load_transcript_events(session_id)
    messages: list[dict[str, Any]] = []
    for event in events:
        replacement_kind = _replacement_kind_from_event(event)
        if replacement_kind:
            messages = _clean_transcript_messages(event.get("replacement_history") or [])
            continue
        kind = str(event.get("kind") or "").strip()
        if kind == "message":
            cleaned = _clean_transcript_messages([dict(event.get("message") or {})])
            messages.extend(cleaned)
    return messages


def _event_has_display_row(event: dict[str, Any]) -> bool:
    kind = str(event.get("kind") or "").strip()
    if kind == "message":
        return True
    return _replacement_kind_from_event(event) in {"compaction", "context_reset", "memory_clear"}


def count_transcript_messages(session_id: str) -> int:
    return sum(1 for event in load_transcript_events(session_id) if event.get("kind") == "message")


def _display_item_ranges(events: list[dict[str, Any]]) -> list[tuple[int, int]]:
    ranges: list[tuple[int, int]] = []
    pending_start: int | None = None
    pending_end = 0

    def flush_pending() -> None:
        nonlocal pending_start, pending_end
        if pending_start is not None:
            ranges.append((pending_start, pending_end))
            pending_start = None
            pending_end = 0

    for index, event in enumerate(events):
        if not _event_has_display_row(event):
            continue
        if str(event.get("kind") or "").strip() != "message":
            flush_pending()
            ranges.append((index, index + 1))
            continue
        message = dict(event.get("message") or {})
        role = str(message.get("role") or "").strip().lower()
        if role in {"assistant", "tool"}:
            if pending_start is None:
                pending_start = index
            pending_end = index + 1
            continue
        flush_pending()
        ranges.append((index, index + 1))
    flush_pending()
    return ranges


def _display_event(event: dict[str, Any]) -> dict[str, Any] | None:
    kind = str(event.get("kind") or "").strip()
    if kind == "message":
        cleaned = _clean_transcript_messages([dict(event.get("message") or {})])
        return cleaned[0] if cleaned else None
    replacement_kind = _replacement_kind_from_event(event)
    if not replacement_kind:
        return None
    if replacement_kind == "compaction":
        count = max(0, int(event.get("compacted_count") or 0))
        return {"role": "system", "content": f"[上下文已压缩：{count} 条消息 → 摘要]"}
    if replacement_kind == "context_reset":
        return {"role": "system", "content": "[上下文已重置]"}
    if replacement_kind == "memory_clear":
        return {"role": "system", "content": "[上下文记忆已清空]"}
    return None


def load_transcript_display_page(
    session_id: str,
    *,
    limit: int = 10,
    page: int | None = None,
) -> dict[str, Any]:
    safe_limit = max(1, min(int(limit), 200))
    events = load_transcript_events(session_id)
    ranges = _display_item_ranges(events)
    total = len(ranges)
    total_pages = max(1, (total + safe_limit - 1) // safe_limit)
    current_page = total_pages if page is None else max(1, min(int(page), total_pages))
    start = min(total, (current_page - 1) * safe_limit)
    end = min(total, start + safe_limit)
    selected_ranges = ranges[start:end]
    if selected_ranges:
        raw_start = selected_ranges[0][0]
        raw_end = selected_ranges[-1][1]
        selected_events = events[raw_start:raw_end]
    else:
        selected_events = []
    messages = [item for event in selected_events if (item := _display_event(event)) is not None]
    return {
        "messages": messages,
        "page": {
            "total": total,
            "raw_message_total": count_transcript_messages(session_id),
            "start": start,
            "end": end,
            "limit": safe_limit,
            "current_page": current_page,
            "total_pages": total_pages,
            "has_previous": current_page > 1,
            "has_next": current_page < total_pages,
        },
    }


__all__ = [
    "append_transcript_message",
    "append_transcript_replacement",
    "count_transcript_messages",
    "ensure_transcript_seeded_from_legacy_messages",
    "load_transcript_display_page",
    "load_transcript_events",
    "replay_transcript_model_context",
    "session_transcript_path",
    "session_transcripts_dir",
]
