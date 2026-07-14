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
