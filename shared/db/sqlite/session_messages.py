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
    "save_session_messages",
    "session_messages_dir",
    "session_messages_path",
]
