from __future__ import annotations

import json
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, TypedDict

from shared.env_config import env_flag, env_text
from shared.logging import logger

_TRACE_STRING_LIMIT = 8192
_IMAGE_DATA_PLACEHOLDER = "[image base64 omitted from wire trace]"
_SENSITIVE_WIRE_KEYS = frozenset(
    {
        "apikey",
        "xapikey",
        "token",
        "accesstoken",
        "refreshtoken",
        "secret",
        "password",
        "authorization",
        "cookie",
        "sessionid",
        "sessiontoken",
    }
)


class WireTraceRecord(TypedDict, total=False):
    ts: str
    kind: str
    session_id: str
    turn_id: str
    step: int
    attempt: int
    provider: str
    endpoint: str
    model: str
    timeout_s: int
    request_headers: dict[str, Any]
    request_payload: dict[str, Any]
    status_code: int
    response_headers: dict[str, Any]
    event: str
    data: str
    event_count: int
    ok: bool
    error: str


@dataclass(frozen=True, slots=True)
class WireTraceConfig:
    enabled: bool
    trace_dir: Path


@dataclass(slots=True)
class WireTraceContext:
    session_id: str
    turn_id: str
    step: int
    attempt: int
    provider: str
    turn_started_at: float = 0.0
    trace_path: str = ""
    turn_dir: str = ""


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[3]


def _now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="milliseconds")


def _normalize_key(key: Any) -> str:
    return "".join(ch for ch in str(key or "").strip().lower() if ch.isalnum())


def _truncate_text(value: str, *, limit: int = _TRACE_STRING_LIMIT) -> str:
    text = str(value or "")
    if limit <= 0 or len(text) <= limit:
        return text

    marker = f"...[omitted {max(1, len(text) - limit)} chars]..."
    available = max(2, limit - len(marker))
    head_len = max(1, available // 2)
    tail_len = max(1, available - head_len)
    omitted = max(1, len(text) - head_len - tail_len)
    marker = f"...[omitted {omitted} chars]..."
    available = max(2, limit - len(marker))
    head_len = max(1, available // 2)
    tail_len = max(1, available - head_len)
    return f"{text[:head_len]}{marker}{text[-tail_len:]}"


def _is_image_block(value: Any) -> bool:
    return str(dict(value or {}).get("type") or "").strip().lower() == "image" and isinstance(
        dict(value or {}).get("source"), dict
    )


def _is_image_source(value: Any) -> bool:
    item = dict(value or {})
    media_type = str(item.get("media_type") or item.get("mimeType") or "").strip().lower()
    source_type = str(item.get("type") or "").strip().lower()
    return source_type == "base64" and "data" in item and media_type.startswith("image/")


def _sanitize_image_source(value: Any) -> dict[str, Any]:
    item = dict(value or {})
    return {
        "type": str(item.get("type") or "base64").strip() or "base64",
        "media_type": str(item.get("media_type") or item.get("mimeType") or "").strip(),
        "data": _IMAGE_DATA_PLACEHOLDER,
    }


def sanitize_wire_payload(
    value: Any,
    *,
    string_limit: int = _TRACE_STRING_LIMIT,
    _current_key: str = "",
    _seen: set[int] | None = None,
) -> Any:
    normalized_key = _normalize_key(_current_key)
    if normalized_key in _SENSITIVE_WIRE_KEYS:
        return "***"

    if value is None or isinstance(value, (bool, int, float)):
        return value

    if isinstance(value, str):
        return _truncate_text(value, limit=string_limit)

    if isinstance(value, (bytes, bytearray)):
        return _truncate_text(value.decode("utf-8", errors="replace"), limit=string_limit)

    seen = _seen if _seen is not None else set()
    if isinstance(value, dict):
        if _is_image_block(value):
            item = dict(value or {})
            return {
                "type": "image",
                "source": _sanitize_image_source(item.get("source")),
            }
        if _is_image_source(value):
            return _sanitize_image_source(value)
        obj_id = id(value)
        if obj_id in seen:
            return "[recursive]"
        seen.add(obj_id)
        try:
            return {
                str(key): sanitize_wire_payload(
                    item,
                    string_limit=string_limit,
                    _current_key=str(key),
                    _seen=seen,
                )
                for key, item in value.items()
            }
        finally:
            seen.discard(obj_id)

    if isinstance(value, (list, tuple, set)):
        obj_id = id(value)
        if obj_id in seen:
            return "[recursive]"
        seen.add(obj_id)
        try:
            return [
                sanitize_wire_payload(
                    item,
                    string_limit=string_limit,
                    _seen=seen,
                )
                for item in value
            ]
        finally:
            seen.discard(obj_id)

    return _truncate_text(str(value), limit=string_limit)


def load_wire_trace_config() -> WireTraceConfig:
    trace_dir_raw = env_text("AGENT_SSE_WIRE_TRACE_DIR", "logs/sse_wire_traces")
    trace_dir = Path(trace_dir_raw or "logs/sse_wire_traces")
    if not trace_dir.is_absolute():
        trace_dir = (_repo_root() / trace_dir).resolve()
    return WireTraceConfig(
        enabled=env_flag("AGENT_SSE_WIRE_TRACE_ENABLED", True),
        trace_dir=trace_dir,
    )


def dated_session_trace_dir(
    base_dir: Path,
    *,
    session_id: str,
    now_ts: float | None = None,
) -> Path:
    safe_session = str(session_id or "").strip()
    moment = time.time() if now_ts is None else float(now_ts)
    dated_dir = base_dir / time.strftime("%Y%m%d", time.localtime(moment))
    if not safe_session:
        return dated_dir

    hour_minute = time.strftime("%H%M", time.localtime(moment))
    return dated_dir / f"{hour_minute}_{safe_session}"


def wire_trace_turn_dir(
    wire_config: WireTraceConfig,
    *,
    session_id: str,
    turn_id: str,
    started_at: float | None = None,
) -> str:
    if not wire_config.enabled:
        return ""
    session = str(session_id or "").strip()
    turn = str(turn_id or "").strip()
    if not session or not turn:
        return ""
    session_dir = dated_session_trace_dir(
        wire_config.trace_dir,
        session_id=session,
        now_ts=started_at,
    )
    return str(session_dir / turn)


class WireTraceWriter:
    def __init__(
        self,
        *,
        context: WireTraceContext,
        wire_config: WireTraceConfig | None = None,
    ) -> None:
        self.context = context
        self.config = wire_config or load_wire_trace_config()
        self._enabled = bool(self.config.enabled)
        self._handle = None
        self._event_count = 0

        if not self._enabled:
            return

        try:
            turn_dir_raw = wire_trace_turn_dir(
                self.config,
                session_id=self.context.session_id,
                turn_id=self.context.turn_id,
                started_at=self.context.turn_started_at,
            )
            if not turn_dir_raw:
                self._enabled = False
                return
            turn_dir = Path(turn_dir_raw)
            turn_dir.mkdir(parents=True, exist_ok=True)
            path = turn_dir / f"step_{self.context.step}_attempt_{self.context.attempt}.jsonl"
            self._handle = path.open("a", encoding="utf-8")
            self.context.turn_dir = str(turn_dir)
            self.context.trace_path = str(path)
        except Exception as error:
            logger.warning("[WireTrace] failed to initialize wire trace file: %s", error)
            self._enabled = False

    @property
    def trace_path(self) -> str:
        return self.context.trace_path

    @property
    def turn_dir(self) -> str:
        return self.context.turn_dir

    @property
    def event_count(self) -> int:
        return self._event_count

    def write_request_start(
        self,
        *,
        endpoint: str,
        model: str,
        timeout_s: int,
        request_headers: dict[str, Any],
        request_payload: dict[str, Any],
    ) -> None:
        self._write(
            {
                "ts": _now_iso(),
                "kind": "request_start",
                "session_id": self.context.session_id,
                "turn_id": self.context.turn_id,
                "step": self.context.step,
                "attempt": self.context.attempt,
                "provider": self.context.provider,
                "endpoint": str(endpoint or "").strip(),
                "model": str(model or "").strip(),
                "timeout_s": int(timeout_s),
                "request_headers": sanitize_wire_payload(dict(request_headers or {})),
                "request_payload": sanitize_wire_payload(dict(request_payload or {})),
            }
        )

    def write_response_start(
        self,
        *,
        status_code: int,
        response_headers: dict[str, Any],
    ) -> None:
        self._write(
            {
                "ts": _now_iso(),
                "kind": "response_start",
                "session_id": self.context.session_id,
                "turn_id": self.context.turn_id,
                "step": self.context.step,
                "attempt": self.context.attempt,
                "provider": self.context.provider,
                "status_code": int(status_code),
                "response_headers": sanitize_wire_payload(dict(response_headers or {})),
            }
        )

    def write_wire_event(self, *, event_name: str, raw_data: str) -> None:
        self._event_count += 1
        self._write(
            {
                "ts": _now_iso(),
                "kind": "wire_event",
                "session_id": self.context.session_id,
                "turn_id": self.context.turn_id,
                "step": self.context.step,
                "attempt": self.context.attempt,
                "provider": self.context.provider,
                "event": str(event_name or "").strip() or "message",
                "data": str(raw_data or ""),
            }
        )

    def write_parse_error(self, *, event_name: str, raw_data: str, error: Exception) -> None:
        self._write(
            {
                "ts": _now_iso(),
                "kind": "parse_error",
                "session_id": self.context.session_id,
                "turn_id": self.context.turn_id,
                "step": self.context.step,
                "attempt": self.context.attempt,
                "provider": self.context.provider,
                "event": str(event_name or "").strip() or "message",
                "data": str(raw_data or ""),
                "error": str(error or "").strip() or type(error).__name__,
            }
        )

    def write_request_end(self, *, ok: bool, error: str = "") -> None:
        self._write(
            {
                "ts": _now_iso(),
                "kind": "request_end",
                "session_id": self.context.session_id,
                "turn_id": self.context.turn_id,
                "step": self.context.step,
                "attempt": self.context.attempt,
                "provider": self.context.provider,
                "ok": bool(ok),
                "event_count": self._event_count,
                "error": str(error or "").strip(),
            }
        )

    def close(self) -> None:
        if self._handle is None:
            return
        try:
            self._handle.close()
        finally:
            self._handle = None

    def _write(self, record: WireTraceRecord) -> None:
        if not self._enabled or self._handle is None:
            return
        try:
            self._handle.write(json.dumps(dict(record or {}), ensure_ascii=False) + "\n")
            self._handle.flush()
        except Exception as error:
            logger.warning("[WireTrace] failed to write wire trace record: %s", error)


__all__ = [
    "WireTraceConfig",
    "WireTraceContext",
    "WireTraceRecord",
    "WireTraceWriter",
    "load_wire_trace_config",
    "sanitize_wire_payload",
    "wire_trace_turn_dir",
]
