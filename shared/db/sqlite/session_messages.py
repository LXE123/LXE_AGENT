from __future__ import annotations

import json
import os
import re
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Any

from shared.agent_state import MESSAGES_KEY, context_state, update_context_state

from ._agent_storage import sanitize_json_for_storage
from .engine import database_path


_SAFE_SESSION_ID_RE = re.compile(r"^[A-Za-z0-9_.-]+$")


def _clean_session_id(session_id: str) -> str:
    safe_session_id = str(session_id or "").strip()
    if not safe_session_id:
        raise RuntimeError("session_id required for session message storage")
    if not _SAFE_SESSION_ID_RE.match(safe_session_id):
        raise RuntimeError(f"invalid session_id for session message storage: {safe_session_id!r}")
    return safe_session_id


def session_messages_dir() -> Path:
    return database_path().parent / "session_messages"


def session_messages_path(session_id: str) -> Path:
    return session_messages_dir() / f"{_clean_session_id(session_id)}.jsonl"


def _clean_messages(messages: Any) -> list[dict[str, Any]]:
    state = update_context_state({}, {MESSAGES_KEY: list(messages or [])})
    return list(context_state(state).get(MESSAGES_KEY) or [])


def load_session_messages(session_id: str) -> list[dict[str, Any]]:
    path = session_messages_path(session_id)
    if not path.is_file():
        return []

    messages: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line_number, raw_line in enumerate(handle, start=1):
            line = raw_line.strip()
            if not line:
                continue
            try:
                parsed = json.loads(line)
            except json.JSONDecodeError as exc:
                raise RuntimeError(
                    f"invalid session message JSONL: path={path} line={line_number}"
                ) from exc
            if isinstance(parsed, dict):
                messages.append(parsed)
    return _clean_messages(messages)


def _message_role(message: dict[str, Any]) -> str:
    return str((message or {}).get("role") or "").strip().lower()


def _is_assistant_turn_message(message: dict[str, Any]) -> bool:
    return _message_role(message) in {"assistant", "tool"}


def _display_item_ranges(messages: list[dict[str, Any]]) -> list[tuple[int, int]]:
    ranges: list[tuple[int, int]] = []
    pending_start: int | None = None
    pending_end = 0

    def flush_pending() -> None:
        nonlocal pending_start, pending_end
        if pending_start is not None:
            ranges.append((pending_start, pending_end))
            pending_start = None
            pending_end = 0

    for index, message in enumerate(messages):
        if _is_assistant_turn_message(message):
            if pending_start is None:
                pending_start = index
            pending_end = index + 1
            continue
        flush_pending()
        ranges.append((index, index + 1))
    flush_pending()
    return ranges


def load_session_messages_page(
    session_id: str,
    *,
    limit: int = 10,
    page: int | None = None,
) -> dict[str, Any]:
    safe_limit = max(1, min(int(limit), 200))
    messages = load_session_messages(session_id)
    raw_total = len(messages)
    ranges = _display_item_ranges(messages)
    total = len(ranges)
    total_pages = max(1, (total + safe_limit - 1) // safe_limit)
    if page is None:
        current_page = total_pages
    else:
        current_page = max(1, min(int(page), total_pages))
    start = min(total, (current_page - 1) * safe_limit)
    end = min(total, start + safe_limit)
    selected_ranges = ranges[start:end]
    if selected_ranges:
        raw_start = selected_ranges[0][0]
        raw_end = selected_ranges[-1][1]
        page_messages = messages[raw_start:raw_end]
    else:
        page_messages = []
    return {
        "messages": page_messages,
        "page": {
            "total": total,
            "raw_message_total": raw_total,
            "start": start,
            "end": end,
            "limit": safe_limit,
            "current_page": current_page,
            "total_pages": total_pages,
            "has_previous": current_page > 1,
            "has_next": current_page < total_pages,
        },
    }


def save_session_messages(session_id: str, messages: Any) -> list[dict[str, Any]]:
    safe_session_id = _clean_session_id(session_id)
    cleaned = _clean_messages(messages)
    target_dir = session_messages_dir()
    target_dir.mkdir(parents=True, exist_ok=True)
    target_path = target_dir / f"{safe_session_id}.jsonl"

    with NamedTemporaryFile(
        "w",
        encoding="utf-8",
        newline="\n",
        delete=False,
        dir=str(target_dir),
        prefix=f".{safe_session_id}.",
        suffix=".tmp",
    ) as handle:
        temp_path = Path(handle.name)
        for message in cleaned:
            payload = sanitize_json_for_storage(message)
            handle.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
            handle.write("\n")

    try:
        os.replace(str(temp_path), str(target_path))
    except Exception:
        try:
            temp_path.unlink(missing_ok=True)
        finally:
            raise
    return cleaned


def clear_session_messages(session_id: str) -> list[dict[str, Any]]:
    return save_session_messages(session_id, [])


__all__ = [
    "clear_session_messages",
    "load_session_messages",
    "load_session_messages_page",
    "save_session_messages",
    "session_messages_dir",
    "session_messages_path",
]
