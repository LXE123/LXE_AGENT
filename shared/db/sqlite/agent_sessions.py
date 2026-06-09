from __future__ import annotations

import os
import shutil
from dataclasses import dataclass
from pathlib import Path
from sqlite3 import Connection, Row
from typing import Any, Optional
from uuid import uuid4

from shared.agent_state import (
    CONTEXT_KEY,
    MESSAGES_KEY,
    RUNTIME_ALLOWED_KEYS,
    RUNTIME_KEY,
    compose_agent_state,
    ensure_agent_state,
    runtime_state,
    split_agent_state_for_storage,
)
from shared.config import config
from shared.db.shared_state_dto import AgentSessionState
from shared.llm.kimi_coding import client as kimi_coding_client
from shared.llm.model_capabilities import _resolve_model_capabilities_match
from shared.llm.provider_catalog import descriptor_for_provider, normalize_provider_name
from shared.logging import logger

from ._agent_storage import (
    json_object_from_storage,
    json_object_to_storage,
    sanitize_json_for_storage,
    utc_now,
)
from .engine import connection_scope
from .session_messages import clear_session_messages, load_session_messages, save_session_messages


MAX_PENDING_EVENTS = 10
_STATE_DATA_PATCH_KEYS = {
    RUNTIME_KEY,
    CONTEXT_KEY,
}
_LEGACY_RUNTIME_KEYS = {
    "active_turn_id",
    "active_card_id",
    "active_turn_started_at",
    "stop_turn_id",
    "stop_requested_at",
}
_METRIC_FIELDS = {
    "tool_call_count",
    "input_tokens",
    "output_tokens",
    "api_call_count",
}
_TITLE_LIMIT = 60


@dataclass
class AgentSessionRecord:
    session_id: str
    source: dict[str, Any]
    model: str
    model_config: dict[str, Any]
    created_at: float
    last_active_at: float
    message_count: int
    tool_call_count: int
    input_tokens: int
    output_tokens: int
    title: str
    api_call_count: int


def _now_ts() -> float:
    return float(utc_now().timestamp())


def _clean_source(value: dict[str, Any] | None) -> dict[str, Any]:
    return sanitize_json_for_storage(dict(value or {}))


def _clean_model_config(value: dict[str, Any] | None) -> dict[str, Any]:
    return sanitize_json_for_storage(dict(value or {}))


def _clean_int(value: Any, *, default: int = 0) -> int:
    try:
        return max(0, int(value))
    except Exception:
        return int(default)


def _clean_float(value: Any, *, default: float = 0.0) -> float:
    try:
        parsed = float(value)
        return parsed if parsed > 0 else float(default)
    except Exception:
        return float(default)


def _config_text(name: str, default: str = "") -> str:
    return str(getattr(config, name, default) or default).strip()


def _current_model_metadata() -> tuple[str, dict[str, Any]]:
    provider_name = os.getenv("AGENT_LLM_PROVIDER", "") or _config_text(
        "AGENT_LLM_PROVIDER",
        kimi_coding_client.PROVIDER_NAME,
    )
    model_override = os.getenv("AGENT_LLM_MODEL", "") or _config_text(
        "AGENT_LLM_MODEL",
        "",
    )
    try:
        provider_name = normalize_provider_name(provider_name)
        descriptor = descriptor_for_provider(provider_name, model_override=model_override)
        capabilities, capability_match = _resolve_model_capabilities_match(
            descriptor.name,
            descriptor.default_model,
        )
        model_config = {
            "provider": descriptor.name,
            "label": descriptor.label,
            "api_style": descriptor.api_style,
            "model": descriptor.default_model,
            "base_url": descriptor.base_url,
            "capability_match": capability_match,
            "context_window_tokens": capabilities.context_window_tokens,
            "max_tokens": capabilities.max_tokens,
            "max_output_tokens": capabilities.max_tokens,
            "supports_vision": capabilities.supports_vision,
            "supports_thinking": capabilities.supports_thinking,
            "supports_temperature": capabilities.supports_temperature,
        }
        return descriptor.default_model, _clean_model_config(model_config)
    except Exception as exc:
        logger.warning("[AgentSessions] model metadata unavailable: %s", exc)
        return "", {}


def _record_from_row(row: Row | None) -> AgentSessionRecord | None:
    if row is None:
        return None
    return AgentSessionRecord(
        session_id=str(row["session_id"]),
        source=json_object_from_storage(
            row["source"],
            field_name="agent_sessions.source",
        ),
        model=str(row["model"] or ""),
        model_config=json_object_from_storage(
            row["model_config"],
            field_name="agent_sessions.model_config",
        ),
        created_at=_clean_float(row["created_at"]),
        last_active_at=_clean_float(row["last_active_at"]),
        message_count=_clean_int(row["message_count"]),
        tool_call_count=_clean_int(row["tool_call_count"]),
        input_tokens=_clean_int(row["input_tokens"]),
        output_tokens=_clean_int(row["output_tokens"]),
        title=str(row["title"] or ""),
        api_call_count=_clean_int(row["api_call_count"]),
    )


def _load_session_record(conn: Connection, session_id: str) -> AgentSessionRecord | None:
    safe_session_id = str(session_id or "").strip()
    if not safe_session_id:
        return None
    row = conn.execute(
        "SELECT * FROM agent_sessions WHERE session_id = ?",
        (safe_session_id,),
    ).fetchone()
    return _record_from_row(row)


def _save_session_record(conn: Connection, record: AgentSessionRecord) -> None:
    conn.execute(
        """
        UPDATE agent_sessions
        SET source = ?,
            model = ?,
            model_config = ?,
            last_active_at = ?,
            message_count = ?,
            tool_call_count = ?,
            input_tokens = ?,
            output_tokens = ?,
            title = ?,
            api_call_count = ?
        WHERE session_id = ?
        """,
        (
            json_object_to_storage(
                _clean_source(record.source),
                field_name="agent_sessions.source",
            ),
            str(record.model or ""),
            json_object_to_storage(
                _clean_model_config(record.model_config),
                field_name="agent_sessions.model_config",
            ),
            float(record.last_active_at or _now_ts()),
            _clean_int(record.message_count),
            _clean_int(record.tool_call_count),
            _clean_int(record.input_tokens),
            _clean_int(record.output_tokens),
            str(record.title or ""),
            _clean_int(record.api_call_count),
            record.session_id,
        ),
    )


def _insert_session_record(conn: Connection, record: AgentSessionRecord) -> None:
    conn.execute(
        """
        INSERT INTO agent_sessions (
            session_id,
            source,
            model,
            model_config,
            created_at,
            last_active_at,
            message_count,
            tool_call_count,
            input_tokens,
            output_tokens,
            title,
            api_call_count
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            record.session_id,
            json_object_to_storage(
                _clean_source(record.source),
                field_name="agent_sessions.source",
            ),
            str(record.model or ""),
            json_object_to_storage(
                _clean_model_config(record.model_config),
                field_name="agent_sessions.model_config",
            ),
            float(record.created_at or _now_ts()),
            float(record.last_active_at or _now_ts()),
            _clean_int(record.message_count),
            _clean_int(record.tool_call_count),
            _clean_int(record.input_tokens),
            _clean_int(record.output_tokens),
            str(record.title or ""),
            _clean_int(record.api_call_count),
        ),
    )


def _normalize_pending_event(event: dict[str, Any] | None) -> dict[str, Any]:
    raw = dict(event or {})
    event_id = str(raw.get("event_id") or "").strip()
    job_id = str(raw.get("job_id") or "").strip()
    text = str(raw.get("text") or "").strip()
    try:
        created_at = int(raw.get("created_at"))
    except Exception as exc:
        raise RuntimeError(f"invalid pending event created_at: {raw.get('created_at')!r}") from exc
    if not event_id:
        raise RuntimeError("invalid pending event: event_id required")
    if not job_id:
        raise RuntimeError("invalid pending event: job_id required")
    if created_at <= 0:
        raise RuntimeError("invalid pending event: created_at must be positive")
    if not text:
        raise RuntimeError("invalid pending event: text required")
    return sanitize_json_for_storage(
        {
            "event_id": event_id,
            "job_id": job_id,
            "created_at": created_at,
            "text": text,
        }
    )


def _load_pending_events(conn: Connection, session_id: str) -> list[dict[str, Any]]:
    rows = conn.execute(
        """
        SELECT event_id, job_id, created_at, text
        FROM agent_session_pending_events
        WHERE session_id = ?
        ORDER BY queue_id ASC
        """,
        (session_id,),
    ).fetchall()
    return [
        _normalize_pending_event(
            {
                "event_id": row["event_id"],
                "job_id": row["job_id"],
                "created_at": row["created_at"],
                "text": row["text"],
            }
        )
        for row in rows
    ]


def _count_pending_events(conn: Connection, session_id: str) -> int:
    row = conn.execute(
        "SELECT COUNT(*) AS count FROM agent_session_pending_events WHERE session_id = ?",
        (session_id,),
    ).fetchone()
    return int(row["count"] if row is not None else 0)


def _has_pending_events(conn: Connection, session_id: str) -> bool:
    row = conn.execute(
        """
        SELECT 1
        FROM agent_session_pending_events
        WHERE session_id = ?
        LIMIT 1
        """,
        (session_id,),
    ).fetchone()
    return row is not None


def _touch_session_row(conn: Connection, session_id: str, base_time: float | None = None) -> None:
    conn.execute(
        "UPDATE agent_sessions SET last_active_at = ? WHERE session_id = ?",
        (_clean_float(base_time, default=_now_ts()) if base_time is not None else _now_ts(), session_id),
    )


def _validate_runtime_patch(runtime_values: dict[str, Any]) -> None:
    invalid_keys = sorted(key for key in dict(runtime_values or {}) if key not in RUNTIME_ALLOWED_KEYS)
    if invalid_keys:
        raise RuntimeError(
            "non-control runtime fields are not allowed in state_data_patch: "
            + ", ".join(invalid_keys)
        )


def _runtime_patch_values(runtime_values: dict[str, Any] | None) -> dict[str, Any]:
    raw = dict(runtime_values or {})
    invalid_keys = sorted(key for key in raw if key not in RUNTIME_ALLOWED_KEYS and key not in _LEGACY_RUNTIME_KEYS)
    if invalid_keys:
        raise RuntimeError(
            "non-control runtime fields are not allowed in state_data_patch: "
            + ", ".join(invalid_keys)
        )
    return {
        key: raw[key]
        for key in RUNTIME_ALLOWED_KEYS
        if key in raw
    }


def _compose_record_state(
    record: AgentSessionRecord,
    *,
    conn: Connection,
) -> dict[str, Any]:
    _ = conn
    context_data = {MESSAGES_KEY: load_session_messages(record.session_id)}
    return compose_agent_state({}, context_data)


def _to_state(
    record: AgentSessionRecord,
    *,
    conn: Connection,
) -> AgentSessionState:
    return AgentSessionState(
        session_id=str(record.session_id),
        source=_clean_source(record.source),
        state_data=_compose_record_state(record, conn=conn),
        model=str(record.model or ""),
        model_config=_clean_model_config(record.model_config),
        created_at=float(record.created_at or 0),
        last_active_at=float(record.last_active_at or 0),
        message_count=_clean_int(record.message_count),
        tool_call_count=_clean_int(record.tool_call_count),
        input_tokens=_clean_int(record.input_tokens),
        output_tokens=_clean_int(record.output_tokens),
        title=str(record.title or ""),
        api_call_count=_clean_int(record.api_call_count),
    )


def _merge_state_data(
    conn: Connection,
    record: AgentSessionRecord,
    patch: dict[str, Any] | None,
) -> int | None:
    _ = conn
    if not patch:
        return None
    raw_patch = dict(patch or {})
    invalid_patch_keys = sorted(key for key in raw_patch if key not in _STATE_DATA_PATCH_KEYS)
    if invalid_patch_keys:
        raise RuntimeError("invalid state_data_patch keys: " + ", ".join(invalid_patch_keys))
    if isinstance(raw_patch.get(RUNTIME_KEY), dict):
        _runtime_patch_values(raw_patch.get(RUNTIME_KEY))
    context_patch = dict(raw_patch.get(CONTEXT_KEY) or {}) if isinstance(raw_patch.get(CONTEXT_KEY), dict) else {}
    if CONTEXT_KEY in raw_patch and MESSAGES_KEY in context_patch:
        saved_messages = save_session_messages(record.session_id, context_patch.get(MESSAGES_KEY))
        return len(saved_messages)
    return None


def _metrics_delta_values(metrics_delta: dict[str, Any] | None) -> dict[str, int]:
    raw = dict(metrics_delta or {})
    return {
        field: _clean_int(raw.get(field), default=0)
        for field in _METRIC_FIELDS
    }


def _title_from_text(text: str) -> str:
    normalized = " ".join(str(text or "").split())
    if not normalized or normalized.startswith("/"):
        return ""
    return normalized[:_TITLE_LIMIT]


def _text_from_user_message(message: dict[str, Any]) -> str:
    content = message.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            raw_block = dict(block or {})
            if str(raw_block.get("type") or "").strip() == "text":
                parts.append(str(raw_block.get("text") or ""))
        return "\n".join(parts).strip()
    return ""


def _title_from_messages(messages: list[dict[str, Any]]) -> str:
    for message in list(messages or []):
        raw_message = dict(message or {})
        if str(raw_message.get("role") or "").strip() != "user":
            continue
        title = _title_from_text(_text_from_user_message(raw_message))
        if title:
            return title
    return ""


def _maybe_fill_title(
    record: AgentSessionRecord,
    *,
    title: str | None = None,
    title_candidate: str | None = None,
    messages: list[dict[str, Any]] | None = None,
) -> None:
    explicit_title = str(title or "").strip()
    if explicit_title:
        record.title = explicit_title[:_TITLE_LIMIT]
        return
    if str(record.title or "").strip():
        return
    candidate = _title_from_text(str(title_candidate or ""))
    if not candidate and messages is not None:
        candidate = _title_from_messages(messages)
    if candidate:
        record.title = candidate


def load_agent_session(session_id: str) -> Optional[AgentSessionState]:
    if not session_id:
        return None
    with connection_scope() as conn:
        record = _load_session_record(conn, session_id)
        if record is None:
            return None
        return _to_state(record, conn=conn)


def create_agent_session(
    *,
    source: dict[str, Any] | None = None,
    state_data: dict[str, Any] | None = None,
    session_id: str = "",
    model: str | None = None,
    model_config: dict[str, Any] | None = None,
    title: str = "",
) -> AgentSessionState:
    now = _now_ts()
    initial_state_data = ensure_agent_state(state_data)
    initial_runtime = runtime_state(initial_state_data)
    _validate_runtime_patch(initial_runtime)
    session_state_data, context_data = split_agent_state_for_storage(initial_state_data)
    _ = session_state_data
    safe_session_id = str(session_id or uuid4().hex)
    default_model, default_model_config = _current_model_metadata()
    selected_model = str(model if model is not None else default_model or "").strip()
    selected_model_config = _clean_model_config(model_config if model_config is not None else default_model_config)

    with connection_scope() as conn:
        conn.execute("BEGIN IMMEDIATE")
        saved_messages = save_session_messages(safe_session_id, dict(context_data or {}).get(MESSAGES_KEY) or [])
        record = AgentSessionRecord(
            session_id=safe_session_id,
            source=_clean_source(source),
            model=selected_model,
            model_config=selected_model_config,
            created_at=now,
            last_active_at=now,
            message_count=len(saved_messages),
            tool_call_count=0,
            input_tokens=0,
            output_tokens=0,
            title=_title_from_text(title),
            api_call_count=0,
        )
        _insert_session_record(conn, record)
        return _to_state(record, conn=conn)


def update_agent_session(
    session_id: str,
    *,
    source: dict[str, Any] | None = None,
    state_data_patch: dict[str, Any] | None = None,
    metrics_delta: dict[str, Any] | None = None,
    model: str | None = None,
    model_config: dict[str, Any] | None = None,
    title: str | None = None,
    title_candidate: str | None = None,
) -> Optional[AgentSessionState]:
    if not session_id:
        return None

    with connection_scope() as conn:
        conn.execute("BEGIN IMMEDIATE")
        record = _load_session_record(conn, session_id)
        if record is None:
            return None

        now = _now_ts()
        if source is not None:
            record.source = _clean_source(source)
        if model is not None:
            record.model = str(model or "").strip()
        if model_config is not None:
            record.model_config = _clean_model_config(model_config)

        new_message_count = _merge_state_data(conn, record, state_data_patch)
        messages = None
        if new_message_count is not None:
            record.message_count = new_message_count
            messages = load_session_messages(record.session_id)

        metrics = _metrics_delta_values(metrics_delta)
        record.tool_call_count += metrics["tool_call_count"]
        record.input_tokens += metrics["input_tokens"]
        record.output_tokens += metrics["output_tokens"]
        record.api_call_count += metrics["api_call_count"]
        _maybe_fill_title(
            record,
            title=title,
            title_candidate=title_candidate,
            messages=messages,
        )
        record.last_active_at = now
        _save_session_record(conn, record)
        return _to_state(record, conn=conn)


def clear_agent_session_memory(
    session_id: str,
    *,
    reason: str = "slash_command_clear",
) -> Optional[AgentSessionState]:
    safe_session_id = str(session_id or "").strip()
    if not safe_session_id:
        return None

    with connection_scope() as conn:
        conn.execute("BEGIN IMMEDIATE")
        record = _load_session_record(conn, safe_session_id)
        if record is None:
            return None

        safe_reason = str(reason or "").strip() or "slash_command_clear"
        message_count_before = len(load_session_messages(safe_session_id))
        clear_session_messages(safe_session_id)
        record.message_count = 0
        record.last_active_at = _now_ts()
        _save_session_record(conn, record)

        logger.info(
            "[AgentSessions] memory cleared: session_id=%s reason=%s message_count_before=%d",
            safe_session_id,
            safe_reason,
            message_count_before,
        )
        return _to_state(record, conn=conn)


def append_agent_session_pending_event(
    session_id: str,
    event: dict[str, Any] | None,
) -> Optional[AgentSessionState]:
    safe_session_id = str(session_id or "").strip()
    if not safe_session_id:
        return None

    try:
        pending_event = _normalize_pending_event(event)
    except RuntimeError as exc:
        logger.error(
            "[AgentSessions] invalid pending event: session_id=%s error=%s event=%s",
            safe_session_id,
            exc,
            event,
        )
        raise

    with connection_scope() as conn:
        conn.execute("BEGIN IMMEDIATE")
        record = _load_session_record(conn, safe_session_id)
        if record is None:
            return None

        now = _now_ts()
        pending_count = _count_pending_events(conn, safe_session_id)
        if pending_count >= MAX_PENDING_EVENTS:
            logger.error(
                "[AgentSessions] pending_events queue full: session_id=%s count=%s max=%s event_id=%s job_id=%s",
                safe_session_id,
                pending_count,
                MAX_PENDING_EVENTS,
                str(pending_event.get("event_id") or "").strip(),
                str(pending_event.get("job_id") or "").strip(),
            )
            raise RuntimeError(
                f"pending_events queue full: session_id={safe_session_id} "
                f"count={pending_count} max={MAX_PENDING_EVENTS}"
            )
        conn.execute(
            """
            INSERT INTO agent_session_pending_events (
                session_id,
                event_id,
                job_id,
                created_at,
                text,
                queued_at
            )
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                safe_session_id,
                str(pending_event["event_id"]),
                str(pending_event["job_id"]),
                str(pending_event["created_at"]),
                str(pending_event["text"]),
                str(now),
            ),
        )
        record.last_active_at = now
        _save_session_record(conn, record)
        return _to_state(record, conn=conn)


def pop_agent_session_pending_events(session_id: str) -> list[dict[str, Any]]:
    safe_session_id = str(session_id or "").strip()
    if not safe_session_id:
        return []

    with connection_scope() as conn:
        conn.execute("BEGIN IMMEDIATE")
        record = _load_session_record(conn, safe_session_id)
        if record is None:
            return []

        pending_events = _load_pending_events(conn, safe_session_id)
        if not pending_events:
            return []
        conn.execute(
            "DELETE FROM agent_session_pending_events WHERE session_id = ?",
            (safe_session_id,),
        )
        record.last_active_at = _now_ts()
        _save_session_record(conn, record)
        return pending_events


def discard_agent_session_pending_event(session_id: str, job_id: str) -> int:
    safe_session_id = str(session_id or "").strip()
    safe_job_id = str(job_id or "").strip()
    if not safe_session_id or not safe_job_id:
        return 0

    with connection_scope() as conn:
        conn.execute("BEGIN IMMEDIATE")
        result = conn.execute(
            """
            DELETE FROM agent_session_pending_events
            WHERE session_id = ? AND job_id = ?
            """,
            (safe_session_id, safe_job_id),
        )
        deleted = int(result.rowcount or 0)
        if deleted > 0:
            _touch_session_row(conn, safe_session_id, _now_ts())
        return deleted


def has_agent_session_pending_events(session_id: str) -> bool:
    safe_session_id = str(session_id or "").strip()
    if not safe_session_id:
        return False

    with connection_scope() as conn:
        return _has_pending_events(conn, safe_session_id)


def cancel_agent_session(
    session_id: str,
    *,
    cancel_reason: str = "user_requested_stop",
) -> Optional[AgentSessionState]:
    safe_session_id = str(session_id or "").strip()
    if not safe_session_id:
        return None

    with connection_scope() as conn:
        conn.execute("BEGIN IMMEDIATE")
        record = _load_session_record(conn, safe_session_id)
        if record is None:
            return None

        safe_reason = str(cancel_reason or "").strip() or "user_requested_stop"
        record.last_active_at = _now_ts()
        _save_session_record(conn, record)
        logger.info(
            "[AgentSessions] session cancelled: session_id=%s reason=%s",
            safe_session_id,
            safe_reason,
        )
        return _to_state(record, conn=conn)


def _session_artifacts_dir(session_id: str) -> Path:
    return (
        Path(__file__).resolve().parents[3]
        / "services"
        / "browser"
        / "artifacts"
        / "amazon_store_agent"
        / str(session_id or "unknown")
    )


def reset_agent_session_context(
    session_id: str,
    *,
    reset_reason: str = "user_requested_context_reset",
) -> Optional[AgentSessionState]:
    safe_session_id = str(session_id or "").strip()
    if not safe_session_id:
        return None

    with connection_scope() as conn:
        conn.execute("BEGIN IMMEDIATE")
        record = _load_session_record(conn, safe_session_id)
        if record is None:
            return None

        safe_reason = str(reset_reason or "").strip() or "user_requested_context_reset"
        clear_session_messages(safe_session_id)
        record.message_count = 0
        record.last_active_at = _now_ts()
        _save_session_record(conn, record)
        logger.info(
            "[AgentSessions] context reset: session_id=%s reason=%s",
            safe_session_id,
            safe_reason,
        )

    shutil.rmtree(_session_artifacts_dir(safe_session_id), ignore_errors=True)
    return load_agent_session(safe_session_id)


__all__ = [
    "append_agent_session_pending_event",
    "cancel_agent_session",
    "clear_agent_session_memory",
    "create_agent_session",
    "discard_agent_session_pending_event",
    "has_agent_session_pending_events",
    "load_agent_session",
    "pop_agent_session_pending_events",
    "reset_agent_session_context",
    "update_agent_session",
]
