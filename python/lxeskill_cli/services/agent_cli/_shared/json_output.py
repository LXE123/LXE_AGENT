from __future__ import annotations

import json
import sys
from typing import Any


def configure_utf8_stdio() -> None:
    for stream_name in ("stdout", "stderr"):
        stream = getattr(sys, stream_name, None)
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            reconfigure(encoding="utf-8", errors="replace")


def _write_event(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(dict(payload or {}), ensure_ascii=False) + "\n")
    sys.stdout.flush()


def write_result_event(payload: dict[str, Any]) -> None:
    event = dict(payload or {})
    event["type"] = "result"
    _write_event(event)


__all__ = [
    "configure_utf8_stdio",
    "write_result_event",
]
