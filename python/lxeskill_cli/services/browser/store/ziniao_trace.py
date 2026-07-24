from __future__ import annotations

import hashlib
import json
import time
import uuid
from contextlib import contextmanager
from contextvars import ContextVar, Token
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

from shared.env_config import env_flag
from shared.logging import get_logger
from shared.repository import state_root


logger = get_logger(__name__)

_TRACE_ID: ContextVar[str] = ContextVar("ziniao_trace_id", default="")
_OPERATION: ContextVar[str] = ContextVar("ziniao_trace_operation", default="")
_STORE_ID: ContextVar[str] = ContextVar("ziniao_trace_store_id", default="")
_STARTED_AT: ContextVar[float] = ContextVar("ziniao_trace_started_at", default=0.0)

_STORE_KEYS = {"browseroauth", "browser_oauth", "store_id", "storeid", "storeoauth"}
_SECRET_KEY_PARTS = ("password", "username", "company")
_ERROR_TEXT_KEYS = {"error", "message", "failure", "failure_reason"}


def _trace_enabled() -> bool:
    return env_flag("ZINIAO_DIAGNOSTIC_TRACE_ENABLED", False)


def _trace_dir() -> Path:
    return (state_root() / "logs" / "ziniao_traces").resolve()


def _now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="milliseconds")


def _date_dir_name(now_ts: float | None = None) -> str:
    moment = time.time() if now_ts is None else float(now_ts)
    return time.strftime("%Y%m%d", time.localtime(moment))


def redact_value(value: Any) -> dict[str, Any]:
    text = str(value or "").strip()
    if not text:
        return {"sha256": "", "suffix": "", "length": 0}
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
    return {
        "sha256": digest[:12],
        "suffix": text[-4:],
        "length": len(text),
    }


def _redact_context_text(value: str) -> str:
    text = str(value or "")
    store_id = str(_STORE_ID.get() or "").strip()
    if store_id:
        text = text.replace(store_id, "[redacted-store]")
    return text


def _sanitize_key(key: str, value: Any) -> Any:
    normalized = str(key or "").strip().lower()
    if any(part in normalized for part in _SECRET_KEY_PARTS):
        return "[redacted]"
    if normalized in _STORE_KEYS:
        return redact_value(value)
    if normalized in _ERROR_TEXT_KEYS and isinstance(value, str):
        return _redact_context_text(value)
    return _sanitize_value(value)


def _sanitize_value(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(key): _sanitize_key(str(key), item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_sanitize_value(item) for item in value]
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return str(value)


def _trace_path(trace_id: str) -> Path:
    safe_trace_id = str(trace_id or "").strip() or uuid.uuid4().hex
    return _trace_dir() / _date_dir_name() / f"{safe_trace_id}.jsonl"


def _elapsed_ms() -> int:
    started_at = float(_STARTED_AT.get() or 0.0)
    if started_at <= 0:
        return 0
    return max(0, int((time.time() - started_at) * 1000))


def trace_event(event: str, level: str = "info", **fields: Any) -> None:
    if not _trace_enabled():
        return

    safe_event = str(event or "").strip()
    if not safe_event:
        return

    trace_id = _TRACE_ID.get() or uuid.uuid4().hex
    store_id = _STORE_ID.get()
    record: dict[str, Any] = {
        "ts": _now_iso(),
        "trace_id": trace_id,
        "operation": str(_OPERATION.get() or "").strip(),
        "event": safe_event,
        "level": str(level or "info").strip() or "info",
        "elapsed_ms": _elapsed_ms(),
    }
    if store_id:
        record["store"] = redact_value(store_id)
    record.update(_sanitize_value(dict(fields or {})))

    try:
        path = _trace_path(trace_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")
    except Exception as exc:
        logger.warning("[ZiniaoTrace] failed to write diagnostic trace: %s", exc)


@contextmanager
def trace_context(operation: str, store_id: str = "") -> Iterator[str]:
    trace_id = uuid.uuid4().hex
    trace_token: Token[str] = _TRACE_ID.set(trace_id)
    operation_token: Token[str] = _OPERATION.set(str(operation or "").strip())
    store_token: Token[str] = _STORE_ID.set(str(store_id or "").strip())
    started_token: Token[float] = _STARTED_AT.set(time.time())
    trace_event("trace.start")
    try:
        yield trace_id
        trace_event("trace.end")
    except Exception as exc:
        trace_event("trace.error", level="error", error_type=type(exc).__name__, error=str(exc))
        raise
    finally:
        _STARTED_AT.reset(started_token)
        _STORE_ID.reset(store_token)
        _OPERATION.reset(operation_token)
        _TRACE_ID.reset(trace_token)


__all__ = ["redact_value", "trace_context", "trace_event"]
