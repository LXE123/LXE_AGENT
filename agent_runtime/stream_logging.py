from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Literal, TypedDict

from shared.config import config
from shared.llm.transports.wire_trace import dated_session_trace_dir
from shared.logging import logger

from .llm_adapter import LLMResponse, LLMStreamEvent
from .types import StreamStepSummary


StreamLogMode = Literal["summary", "debug", "trace"]
_TERMINAL_PREVIEW_LIMIT = 400
_TRACE_STRING_LIMIT = 8192
_SENSITIVE_LOG_KEYS = frozenset(
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


class StreamTraceRecord(TypedDict, total=False):
    ts: str
    kind: str
    session_id: str
    turn_id: str
    step: int
    attempt: int
    provider: str
    mode: StreamLogMode
    elapsed_ms: int
    event_count: int
    text_chars: int
    text_blocks: int
    thinking_chars: int
    thinking_blocks: int
    redacted_thinking_blocks: int
    tool_use_count: int
    stop_reason: str
    message_id: str
    model: str
    event_type: str
    index: int
    text: str
    thinking_text: str
    signature: str
    redacted_data: str
    tool_call: dict[str, Any] | None
    usage: dict[str, Any]
    error: str
    raw: dict[str, Any]


@dataclass(frozen=True, slots=True)
class StreamLoggingConfig:
    mode: StreamLogMode
    trace_enabled: bool
    heartbeat_ms: int
    heartbeat_chars: int
    debug_preview_chars: int
    trace_dir: Path


@dataclass(slots=True)
class _AttemptSnapshot:
    attempt: int
    started_at: float
    event_count: int = 0
    text_chars: int = 0
    text_blocks: int = 0
    thinking_chars: int = 0
    thinking_blocks: int = 0
    redacted_thinking_blocks: int = 0
    tool_use_count: int = 0
    stop_reason: str = ""
    message_id: str = ""
    model: str = ""
    preview: str = ""
    last_heartbeat_at: float = 0.0
    last_heartbeat_visible_chars: int = 0
    text_indexes: set[int] = field(default_factory=set)
    saw_unindexed_text: bool = False
    thinking_indexes: set[int] = field(default_factory=set)
    redacted_indexes: set[int] = field(default_factory=set)


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def _now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="milliseconds")


def _safe_int(value: Any, default: int, *, minimum: int = 0) -> int:
    try:
        parsed = int(value)
    except Exception:
        parsed = int(default)
    return max(int(minimum), parsed)


def _normalize_key(key: Any) -> str:
    return "".join(ch for ch in str(key or "").strip().lower() if ch.isalnum())


def _truncate_text(value: str, *, limit: int) -> str:
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


def sanitize_log_payload(
    value: Any,
    *,
    string_limit: int = _TRACE_STRING_LIMIT,
    _current_key: str = "",
    _seen: set[int] | None = None,
) -> Any:
    normalized_key = _normalize_key(_current_key)
    if normalized_key in _SENSITIVE_LOG_KEYS:
        return "***"

    if value is None or isinstance(value, (bool, int, float)):
        return value

    if isinstance(value, str):
        return _truncate_text(value, limit=string_limit)

    if isinstance(value, (bytes, bytearray)):
        return _truncate_text(value.decode("utf-8", errors="replace"), limit=string_limit)

    seen = _seen if _seen is not None else set()
    if isinstance(value, dict):
        obj_id = id(value)
        if obj_id in seen:
            return "[recursive]"
        seen.add(obj_id)
        try:
            return {
                str(key): sanitize_log_payload(
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
                sanitize_log_payload(
                    item,
                    string_limit=string_limit,
                    _seen=seen,
                )
                for item in value
            ]
        finally:
            seen.discard(obj_id)

    return _truncate_text(str(value), limit=string_limit)


def format_log_payload_preview(value: Any, *, limit: int = _TERMINAL_PREVIEW_LIMIT) -> str:
    sanitized = sanitize_log_payload(value, string_limit=_TRACE_STRING_LIMIT)
    try:
        preview = json.dumps(sanitized, ensure_ascii=False, separators=(",", ":"))
    except Exception:
        preview = str(sanitized or "")
    return _truncate_text(preview, limit=limit)


def _tool_call_dict(event: LLMStreamEvent) -> dict[str, Any] | None:
    if event.tool_call is None:
        return None
    return {
        "id": str(event.tool_call.id or "").strip(),
        "name": str(event.tool_call.name or "").strip(),
        "arguments": sanitize_log_payload(dict(event.tool_call.arguments or {})),
    }


def _normalize_preview(text: str, *, limit: int) -> str:
    safe_text = " ".join(str(text or "").split())
    if len(safe_text) <= limit:
        return safe_text
    return safe_text[: max(1, limit - 3)].rstrip() + "..."


def load_stream_logging_config() -> StreamLoggingConfig:
    raw_mode = str(getattr(config, "AGENT_STREAM_LOG_MODE", "summary") or "summary").strip().lower()
    mode: StreamLogMode = raw_mode if raw_mode in {"summary", "debug", "trace"} else "summary"

    trace_dir_raw = str(getattr(config, "AGENT_STREAM_TRACE_DIR", "logs/agent_traces") or "logs/agent_traces").strip()
    trace_dir = Path(trace_dir_raw or "logs/agent_traces")
    if not trace_dir.is_absolute():
        trace_dir = (_repo_root() / trace_dir).resolve()

    return StreamLoggingConfig(
        mode=mode,
        trace_enabled=bool(getattr(config, "AGENT_STREAM_TRACE_ENABLED", True)),
        heartbeat_ms=_safe_int(getattr(config, "AGENT_STREAM_HEARTBEAT_MS", 1000), 1000),
        heartbeat_chars=_safe_int(getattr(config, "AGENT_STREAM_HEARTBEAT_CHARS", 300), 300, minimum=1),
        debug_preview_chars=_safe_int(getattr(config, "AGENT_STREAM_DEBUG_PREVIEW_CHARS", 80), 80, minimum=1),
        trace_dir=trace_dir,
    )


class TurnTraceWriter:
    def __init__(
        self,
        *,
        session_id: str,
        turn_id: str,
        config: StreamLoggingConfig,
        started_at: float | None = None,
    ) -> None:
        self.session_id = str(session_id or "").strip()
        self.turn_id = str(turn_id or "").strip()
        self.mode = config.mode
        self._enabled = bool(config.trace_enabled)
        self._handle = None
        self._path = ""
        self._started_at = 0.0 if started_at is None else float(started_at)

        if not self._enabled:
            return

        try:
            session_dir = dated_session_trace_dir(
                config.trace_dir,
                session_id=self.session_id,
                now_ts=self._started_at or None,
            )
            session_dir.mkdir(parents=True, exist_ok=True)
            path = session_dir / f"{self.turn_id}.jsonl"
            self._handle = path.open("a", encoding="utf-8")
            self._path = str(path)
        except Exception as error:
            logger.warning("[Turn:TRACE] failed to initialize trace file: %s", error)
            self._enabled = False

    @property
    def trace_path(self) -> str:
        return self._path

    def write(self, record: StreamTraceRecord) -> None:
        if not self._enabled or self._handle is None:
            return
        try:
            self._handle.write(json.dumps(dict(record or {}), ensure_ascii=False) + "\n")
            self._handle.flush()
        except Exception as error:
            logger.warning("[Turn:TRACE] failed to write trace record: %s", error)

    def close(self) -> None:
        if self._handle is None:
            return
        try:
            self._handle.close()
        finally:
            self._handle = None


class StepStreamObserver:
    def __init__(
        self,
        *,
        step_idx: int,
        provider: str,
        config: StreamLoggingConfig,
        trace_writer: TurnTraceWriter | None,
    ) -> None:
        self.step_idx = int(step_idx)
        self.provider = str(provider or "").strip() or "-"
        self.config = config
        self.trace_writer = trace_writer
        self._attempts = 0
        self._current: _AttemptSnapshot | None = None
        self._last_snapshot: _AttemptSnapshot | None = None

    def start_attempt(self, attempt: int) -> None:
        now = time.monotonic()
        self._attempts = max(self._attempts, int(attempt))
        self._current = _AttemptSnapshot(
            attempt=int(attempt),
            started_at=now,
            last_heartbeat_at=now,
        )
        self._log_stream(
            "start",
            attempt=int(attempt),
            provider=self.provider,
            model="-",
        )
        self._write_trace(
            {
                "ts": _now_iso(),
                "kind": "attempt_start",
                "session_id": self._session_id(),
                "turn_id": self._turn_id(),
                "step": self.step_idx,
                "attempt": int(attempt),
                "provider": self.provider,
                "mode": self.config.mode,
            }
        )

    def observe(self, event: LLMStreamEvent) -> None:
        if self._current is None:
            return

        snapshot = self._current
        snapshot.event_count += 1
        if event.message_id:
            snapshot.message_id = str(event.message_id or "").strip()
        if event.model:
            snapshot.model = str(event.model or "").strip()
        if event.stop_reason:
            snapshot.stop_reason = str(event.stop_reason or "").strip()

        if event.event_type == "text_delta":
            text = str(event.text or "")
            snapshot.text_chars += len(text)
            if event.index >= 0:
                snapshot.text_indexes.add(int(event.index))
            elif text and not snapshot.saw_unindexed_text:
                snapshot.saw_unindexed_text = True
            snapshot.text_blocks = len(snapshot.text_indexes) + (1 if snapshot.saw_unindexed_text else 0)
            if self.config.mode == "debug" and len(snapshot.preview) < self.config.debug_preview_chars:
                snapshot.preview = (snapshot.preview + text)[: self.config.debug_preview_chars]
        elif event.event_type == "thinking_delta":
            text = str(event.thinking_text or event.text or "")
            snapshot.thinking_chars += len(text)
            if event.index >= 0:
                snapshot.thinking_indexes.add(int(event.index))
            snapshot.thinking_blocks = len(snapshot.thinking_indexes)
            if self.config.mode == "debug" and len(snapshot.preview) < self.config.debug_preview_chars:
                snapshot.preview = (snapshot.preview + text)[: self.config.debug_preview_chars]
        elif event.event_type == "redacted_thinking":
            if event.index >= 0:
                snapshot.redacted_indexes.add(int(event.index))
            snapshot.redacted_thinking_blocks = len(snapshot.redacted_indexes) or 1
            if self.config.mode == "debug" and len(snapshot.preview) < self.config.debug_preview_chars:
                snapshot.preview = (snapshot.preview + str(event.text or ""))[: self.config.debug_preview_chars]
        elif event.event_type == "tool_use":
            snapshot.tool_use_count += 1
            self._log_tool_use(event=event, snapshot=snapshot)

        if self.config.mode == "trace":
            self._log_sse(event=event, attempt=snapshot.attempt)

        self._write_trace(
            {
                "ts": _now_iso(),
                "kind": "stream_event",
                "session_id": self._session_id(),
                "turn_id": self._turn_id(),
                "step": self.step_idx,
                "attempt": snapshot.attempt,
                "event_type": str(event.event_type or "").strip(),
                "index": int(event.index),
                "text": str(event.text or ""),
                "thinking_text": str(event.thinking_text or ""),
                "signature": str(event.signature or ""),
                "redacted_data": str(event.redacted_data or ""),
                "tool_call": _tool_call_dict(event),
                "usage": dict(event.usage or {}),
                "stop_reason": str(event.stop_reason or "").strip(),
                "message_id": str(event.message_id or "").strip(),
                "model": str(event.model or "").strip(),
                "thinking_chars": snapshot.thinking_chars,
                "thinking_blocks": snapshot.thinking_blocks,
                "redacted_thinking_blocks": snapshot.redacted_thinking_blocks,
                "raw": sanitize_log_payload(dict(event.raw or {})),
            }
        )
        self._maybe_log_heartbeat(snapshot=snapshot)

    def fail_attempt(self, error: Exception) -> None:
        if self._current is None:
            return
        snapshot = self._current
        elapsed_ms = int((time.monotonic() - snapshot.started_at) * 1000)
        message = str(error or "").strip() or type(error).__name__
        self._log_stream(
            "error",
            attempt=snapshot.attempt,
            elapsed_ms=elapsed_ms,
            events=snapshot.event_count,
            error=message,
        )
        self._write_trace(
            {
                "ts": _now_iso(),
                "kind": "attempt_error",
                "session_id": self._session_id(),
                "turn_id": self._turn_id(),
                "step": self.step_idx,
                "attempt": snapshot.attempt,
                "elapsed_ms": elapsed_ms,
                "event_count": snapshot.event_count,
                "text_chars": snapshot.text_chars,
                "text_blocks": snapshot.text_blocks,
                "thinking_chars": snapshot.thinking_chars,
                "thinking_blocks": snapshot.thinking_blocks,
                "redacted_thinking_blocks": snapshot.redacted_thinking_blocks,
                "tool_use_count": snapshot.tool_use_count,
                "stop_reason": snapshot.stop_reason,
                "message_id": snapshot.message_id,
                "model": snapshot.model,
                "error": message,
            }
        )
        self._last_snapshot = snapshot
        self._current = None

    def finish_attempt(self, response: LLMResponse) -> None:
        if self._current is None:
            return
        snapshot = self._current
        raw = dict(getattr(response, "raw", None) or {})
        if not snapshot.stop_reason:
            snapshot.stop_reason = str(raw.get("stop_reason") or "").strip()
        if not snapshot.message_id:
            snapshot.message_id = str(raw.get("id") or "").strip()
        if not snapshot.model:
            snapshot.model = str(raw.get("model") or "").strip()

        elapsed_ms = int((time.monotonic() - snapshot.started_at) * 1000)
        self._log_stream(
            "stop",
            attempt=snapshot.attempt,
            stop_reason=snapshot.stop_reason or "-",
            elapsed_ms=elapsed_ms,
            events=snapshot.event_count,
            text_chars=snapshot.text_chars,
            thinking_chars=snapshot.thinking_chars,
            thinking_blocks=snapshot.thinking_blocks,
            redacted_thinking_blocks=snapshot.redacted_thinking_blocks,
            tool_uses=snapshot.tool_use_count,
        )
        self._write_trace(
            {
                "ts": _now_iso(),
                "kind": "attempt_end",
                "session_id": self._session_id(),
                "turn_id": self._turn_id(),
                "step": self.step_idx,
                "attempt": snapshot.attempt,
                "elapsed_ms": elapsed_ms,
                "event_count": snapshot.event_count,
                "text_chars": snapshot.text_chars,
                "text_blocks": snapshot.text_blocks,
                "thinking_chars": snapshot.thinking_chars,
                "thinking_blocks": snapshot.thinking_blocks,
                "redacted_thinking_blocks": snapshot.redacted_thinking_blocks,
                "tool_use_count": snapshot.tool_use_count,
                "stop_reason": snapshot.stop_reason,
                "message_id": snapshot.message_id,
                "model": snapshot.model,
            }
        )
        self._last_snapshot = snapshot
        self._current = None

    def summary(self) -> StreamStepSummary:
        snapshot = self._last_snapshot or self._current
        if snapshot is None:
            return StreamStepSummary(
                attempts=self._attempts,
                trace_path=self.trace_writer.trace_path if self.trace_writer is not None else "",
            )
        return StreamStepSummary(
            attempts=self._attempts,
            event_count=snapshot.event_count,
            text_chars=snapshot.text_chars,
            text_blocks=snapshot.text_blocks,
            thinking_chars=snapshot.thinking_chars,
            thinking_blocks=snapshot.thinking_blocks,
            redacted_thinking_blocks=snapshot.redacted_thinking_blocks,
            tool_use_count=snapshot.tool_use_count,
            stop_reason=snapshot.stop_reason,
            message_id=snapshot.message_id,
            model=snapshot.model,
            trace_path=self.trace_writer.trace_path if self.trace_writer is not None else "",
        )

    def _maybe_log_heartbeat(self, *, snapshot: _AttemptSnapshot) -> None:
        visible_chars = snapshot.text_chars + snapshot.thinking_chars
        if visible_chars <= 0 and snapshot.redacted_thinking_blocks <= 0:
            return
        elapsed_ms = int((time.monotonic() - snapshot.last_heartbeat_at) * 1000)
        chars_since_last = visible_chars - snapshot.last_heartbeat_visible_chars
        if elapsed_ms < self.config.heartbeat_ms and chars_since_last < self.config.heartbeat_chars:
            return

        payload: dict[str, Any] = {
            "attempt": snapshot.attempt,
            "elapsed_ms": int((time.monotonic() - snapshot.started_at) * 1000),
            "events": snapshot.event_count,
            "text_chars": snapshot.text_chars,
            "text_blocks": snapshot.text_blocks,
            "thinking_chars": snapshot.thinking_chars,
            "thinking_blocks": snapshot.thinking_blocks,
            "redacted_thinking_blocks": snapshot.redacted_thinking_blocks,
            "tool_uses": snapshot.tool_use_count,
        }
        if self.config.mode == "debug" and snapshot.preview:
            payload["preview"] = _normalize_preview(snapshot.preview, limit=self.config.debug_preview_chars)
        self._log_stream("heartbeat", **payload)
        snapshot.last_heartbeat_at = time.monotonic()
        snapshot.last_heartbeat_visible_chars = visible_chars

    def _log_tool_use(self, *, event: LLMStreamEvent, snapshot: _AttemptSnapshot) -> None:
        tool_name = str(getattr(event.tool_call, "name", "") or "").strip() or "-"
        arguments = dict(getattr(event.tool_call, "arguments", None) or {})
        input_keys = ",".join(sorted(arguments)) if arguments else "-"
        try:
            input_chars = len(json.dumps(arguments, ensure_ascii=False))
        except Exception:
            input_chars = len(str(arguments or ""))
        self._log_stream(
            "tool_use",
            attempt=snapshot.attempt,
            index=int(event.index),
            tool=tool_name,
            input_keys=input_keys,
            input_chars=input_chars,
            input=format_log_payload_preview(arguments),
        )

    def _log_sse(self, *, event: LLMStreamEvent, attempt: int) -> None:
        logger.info(
            "[Turn:SSE] step=%d attempt=%d event=%s index=%d chars=%d tool=%s stop=%s",
            self.step_idx,
            attempt,
            str(event.event_type or "").strip() or "-",
            int(event.index),
            len(str(event.text or "")),
            str(getattr(event.tool_call, "name", "") or "").strip() or "-",
            str(event.stop_reason or "").strip() or "-",
        )

    def _log_stream(self, phase: str, **fields: Any) -> None:
        payload = " ".join(
            f"{key}={value}"
            for key, value in fields.items()
            if value not in {None, ""}
        )
        message = f"[Turn:STREAM] step={self.step_idx} phase={phase}"
        if payload:
            message = f"{message} {payload}"
        if phase == "error":
            logger.warning(message)
            return
        logger.info(message)

    def _session_id(self) -> str:
        if self.trace_writer is None:
            return ""
        return self.trace_writer.session_id

    def _turn_id(self) -> str:
        if self.trace_writer is None:
            return ""
        return self.trace_writer.turn_id

    def _write_trace(self, record: StreamTraceRecord) -> None:
        if self.trace_writer is None:
            return
        self.trace_writer.write(record)


__all__ = [
    "format_log_payload_preview",
    "sanitize_log_payload",
    "StepStreamObserver",
    "StreamLogMode",
    "StreamLoggingConfig",
    "StreamTraceRecord",
    "TurnTraceWriter",
    "load_stream_logging_config",
]
