from __future__ import annotations

import json
import sys
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any

_EVENT_WRITER: ContextVar[Any] = ContextVar("amazon_store_agent_event_writer", default=None)


def _stdout_json_line_writer(payload: dict[str, Any]) -> None:
    encoded = (json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8")
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


@contextmanager
def bind_event_writer(writer) -> Any:
    token = _EVENT_WRITER.set(writer)
    try:
        yield
    finally:
        _EVENT_WRITER.reset(token)


def _write_json_line(payload: dict[str, Any]) -> None:
    writer = _EVENT_WRITER.get()
    if callable(writer):
        writer(dict(payload or {}))
        return
    _stdout_json_line_writer(payload)


def emit_progress(text: str) -> None:
    _write_json_line({"type": "progress", "text": str(text or "").strip()})


def emit_artifact(*, path: str, artifact_type: str = "screenshot", label: str = "") -> None:
    _write_json_line(
        {
            "type": "artifact",
            "artifact_type": str(artifact_type or "").strip() or "artifact",
            "path": str(path or "").strip(),
            "label": str(label or "").strip(),
        }
    )


def emit_direct_delivery(
    *,
    delivery_kind: str,
    title: str = "",
    content: str = "",
    file_path: str = "",
    sequence: int = 0,
    total: int = 0,
) -> None:
    _write_json_line(
        {
            "type": "direct_delivery",
            "delivery_kind": str(delivery_kind or "").strip(),
            "title": str(title or "").strip(),
            "content": str(content or ""),
            "file_path": str(file_path or "").strip(),
            "sequence": int(sequence or 0),
            "total": int(total or 0),
        }
    )


def emit_result(
    *,
    success: bool,
    status: str,
    message: str,
    waiting_reason: str = "",
    state_data: dict[str, Any] | None = None,
    error: str = "",
) -> None:
    payload = {
        "type": "result",
        "success": bool(success),
        "status": str(status or "").strip(),
        "message": str(message or "").strip(),
        "waiting_reason": str(waiting_reason or "").strip(),
        "state_data": dict(state_data or {}),
        "error": str(error or "").strip(),
    }
    _write_json_line(payload)
