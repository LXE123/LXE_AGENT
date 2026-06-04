from __future__ import annotations

import shutil
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from sqlite3 import Connection, Row
from typing import Any, Optional
from uuid import uuid4

from shared.agent_sessions import (
    ACTIVE_AGENT_SESSION_STATUSES,
    AgentSessionStatus,
    TERMINAL_AGENT_SESSION_STATUSES,
)
from shared.agent_state import (
    CONTEXT_KEY,
    MESSAGES_KEY,
    RUNTIME_ALLOWED_KEYS,
    RUNTIME_KEY,
    compose_agent_state,
    ensure_agent_state,
    reset_context_only,
    runtime_state,
    split_agent_state_for_storage,
)
from shared.db.shared_state_dto import AgentSessionState
from shared.logging import logger

from ._agent_storage import (
    datetime_from_storage,
    datetime_to_storage,
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


@dataclass
class AgentSessionRecord:
    session_id: str
    source: dict[str, Any]
    status: str
    state_data: dict[str, Any]
    created_at: Optional[datetime]
    updated_at: Optional[datetime]


def _session_activity_marker(base_time: Optional[datetime] = None) -> int:
    current = base_time or utc_now()
    return int(current.timestamp())


def _clean_source(value: dict[str, Any] | None) -> dict[str, Any]:
    return sanitize_json_for_storage(dict(value or {}))


def _clean_session_storage_state(value: dict[str, Any] | None) -> dict[str, Any]:
    runtime_storage, _ = split_agent_state_for_storage(sanitize_json_for_storage(value))
    return sanitize_json_for_storage(runtime_storage)


def _record_from_row(row: Row | None) -> AgentSessionRecord | None:
    if row is None:
        return None
    return AgentSessionRecord(
        session_id=str(row["session_id"]),
        source=json_object_from_storage(
            row["source"],
            field_name="agent_sessions.source",
        ),
        status=str(row["status"]),
        state_data=json_object_from_storage(
            row["state_data"],
            field_name="agent_sessions.state_data",
        ),
        created_at=datetime_from_storage(row["created_at"]),
        updated_at=datetime_from_storage(row["updated_at"]),
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
            status = ?,
            state_data = ?,
            updated_at = ?
        WHERE session_id = ?
        """,
        (
            json_object_to_storage(
                _clean_source(record.source),
                field_name="agent_sessions.source",
            ),
            record.status,
            json_object_to_storage(
                record.state_data,
                field_name="agent_sessions.state_data",
            ),
            datetime_to_storage(record.updated_at or utc_now()),
            record.session_id,
        ),
    )


def _insert_session_record(conn: Connection, record: AgentSessionRecord) -> None:
    conn.execute(
        """
        INSERT INTO agent_sessions (
            session_id,
            source,
            status,
            state_data,
            created_at,
            updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (
            record.session_id,
            json_object_to_storage(
                _clean_source(record.source),
                field_name="agent_sessions.source",
            ),
            record.status,
            json_object_to_storage(
                record.state_data,
                field_name="agent_sessions.state_data",
            ),
            datetime_to_storage(record.created_at or utc_now()),
            datetime_to_storage(record.updated_at or utc_now()),
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


def _touch_session_row(conn: Connection, session_id: str, base_time: datetime) -> None:
    conn.execute(
        "UPDATE agent_sessions SET updated_at = ? WHERE session_id = ?",
        (datetime_to_storage(base_time), session_id),
    )


def _validate_runtime_patch(runtime_values: dict[str, Any]) -> None:
    invalid_keys = sorted(key for key in dict(runtime_values or {}) if key not in RUNTIME_ALLOWED_KEYS)
    if invalid_keys:
        raise RuntimeError(
            "non-control runtime fields are not allowed in state_data_patch: "
            + ", ".join(invalid_keys)
        )


def _compose_record_state(
    record: AgentSessionRecord,
    *,
    conn: Connection,
) -> dict[str, Any]:
    _ = conn
    raw_state = dict(record.state_data or {})
    context_data = {MESSAGES_KEY: load_session_messages(record.session_id)}
    return compose_agent_state(raw_state, context_data)


def _touch_session_activity(record: AgentSessionRecord, base_time: Optional[datetime] = None) -> None:
    now = base_time or utc_now()
    runtime = runtime_state(record.state_data)
    _validate_runtime_patch(runtime)
    runtime["session_activity_at"] = _session_activity_marker(now)
    record.state_data = _clean_session_storage_state({RUNTIME_KEY: runtime})


def _cancel_incompatible_session_record(
    conn: Connection,
    record: AgentSessionRecord,
    *,
    base_time: Optional[datetime] = None,
) -> None:
    now = base_time or utc_now()
    record.state_data = _clean_session_storage_state(
        {
            RUNTIME_KEY: {
                "session_activity_at": _session_activity_marker(now),
            },
        }
    )
    record.status = AgentSessionStatus.CANCELLED
    record.updated_at = now
    _save_session_record(conn, record)


def _prepare_loaded_active_session(
    conn: Connection,
    record: AgentSessionRecord,
) -> Optional[AgentSessionState]:
    now = utc_now()
    raw_state = dict(record.state_data or {})
    if not isinstance(raw_state.get(RUNTIME_KEY), dict):
        _cancel_incompatible_session_record(conn, record, base_time=now)
        return None
    return _to_state(record, conn=conn)


def _to_state(
    record: AgentSessionRecord,
    *,
    conn: Connection,
) -> AgentSessionState:
    return AgentSessionState(
        session_id=str(record.session_id),
        source=_clean_source(record.source),
        status=str(record.status),
        state_data=_compose_record_state(record, conn=conn),
        created_at=record.created_at,
        updated_at=record.updated_at,
    )


def _merge_state_data(
    conn: Connection,
    record: AgentSessionRecord,
    patch: dict[str, Any] | None,
    *,
    base_time: Optional[datetime] = None,
) -> None:
    if not patch:
        return
    now = base_time or utc_now()
    raw_patch = dict(patch or {})
    invalid_patch_keys = sorted(key for key in raw_patch if key not in _STATE_DATA_PATCH_KEYS)
    if invalid_patch_keys:
        raise RuntimeError("invalid state_data_patch keys: " + ", ".join(invalid_patch_keys))
    runtime_patch_values = (
        dict(raw_patch.get(RUNTIME_KEY) or {})
        if isinstance(raw_patch.get(RUNTIME_KEY), dict)
        else {}
    )
    context_patch = dict(raw_patch.get(CONTEXT_KEY) or {}) if isinstance(raw_patch.get(CONTEXT_KEY), dict) else {}
    current_state = dict(record.state_data or {})
    existing_runtime = dict(current_state.get(RUNTIME_KEY) or {})
    _validate_runtime_patch(existing_runtime)
    _validate_runtime_patch(runtime_patch_values)

    if runtime_patch_values:
        existing_runtime.update(runtime_patch_values)
    current_state[RUNTIME_KEY] = existing_runtime
    record.state_data = _clean_session_storage_state(current_state)
    if CONTEXT_KEY in raw_patch:
        _ = now
        if MESSAGES_KEY in context_patch:
            save_session_messages(record.session_id, context_patch.get(MESSAGES_KEY))


def load_agent_session(session_id: str) -> Optional[AgentSessionState]:
    if not session_id:
        return None
    with connection_scope() as conn:
        record = _load_session_record(conn, session_id)
        if record is None:
            return None
        if str(record.status or "").strip() in ACTIVE_AGENT_SESSION_STATUSES:
            return _prepare_loaded_active_session(conn, record)
        return _to_state(record, conn=conn)


def create_agent_session(
    *,
    source: dict[str, Any] | None,
    status: str,
    state_data: dict[str, Any] | None = None,
    session_id: str = "",
) -> AgentSessionState:
    now = utc_now()
    initial_state_data = ensure_agent_state(state_data)
    initial_runtime = runtime_state(initial_state_data)
    _validate_runtime_patch(initial_runtime)
    initial_runtime["session_activity_at"] = _session_activity_marker(now)
    initial_state_data[RUNTIME_KEY] = initial_runtime
    session_state_data, context_data = split_agent_state_for_storage(initial_state_data)
    clean_session_state = _clean_session_storage_state(session_state_data)
    safe_session_id = str(session_id or uuid4().hex)

    with connection_scope() as conn:
        conn.execute("BEGIN IMMEDIATE")
        save_session_messages(safe_session_id, dict(context_data or {}).get(MESSAGES_KEY) or [])
        record = AgentSessionRecord(
            session_id=safe_session_id,
            source=_clean_source(source),
            status=str(status or "").strip(),
            state_data=clean_session_state,
            created_at=now,
            updated_at=now,
        )
        _insert_session_record(conn, record)
        return _to_state(record, conn=conn)


def update_agent_session(
    session_id: str,
    *,
    source: dict[str, Any] | None = None,
    status: str | None = None,
    state_data_patch: dict[str, Any] | None = None,
) -> Optional[AgentSessionState]:
    if not session_id:
        return None

    with connection_scope() as conn:
        conn.execute("BEGIN IMMEDIATE")
        record = _load_session_record(conn, session_id)
        if record is None:
            return None

        now = utc_now()
        if source is not None:
            record.source = _clean_source(source)
        if status is not None:
            record.status = str(status or "").strip() or record.status
        _merge_state_data(conn, record, state_data_patch, base_time=now)
        record.updated_at = now
        _save_session_record(conn, record)
        return _to_state(record, conn=conn)


def request_agent_turn_stop(
    session_id: str,
    *,
    turn_id: str,
    reason: str = "slash_command_stop",
) -> Optional[AgentSessionState]:
    safe_session_id = str(session_id or "").strip()
    safe_turn_id = str(turn_id or "").strip()
    if not safe_session_id or not safe_turn_id:
        return None

    with connection_scope() as conn:
        conn.execute("BEGIN IMMEDIATE")
        record = _load_session_record(conn, safe_session_id)
        if record is None:
            return None

        now = utc_now()
        runtime = runtime_state(record.state_data)
        _validate_runtime_patch(runtime)
        runtime["session_activity_at"] = _session_activity_marker(now)
        runtime["stop_turn_id"] = safe_turn_id
        runtime["stop_requested_at"] = _session_activity_marker(now)
        _ = reason
        record.state_data = _clean_session_storage_state({RUNTIME_KEY: runtime})

        record.updated_at = now
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

        now = utc_now()
        safe_reason = str(reason or "").strip() or "slash_command_clear"
        status_before = str(record.status or "").strip()

        message_count_before = len(load_session_messages(safe_session_id))
        clear_session_messages(safe_session_id)

        runtime = runtime_state(record.state_data)
        _validate_runtime_patch(runtime)
        runtime["session_activity_at"] = _session_activity_marker(now)
        record.state_data = _clean_session_storage_state({RUNTIME_KEY: runtime})

        if str(record.status or "").strip() not in TERMINAL_AGENT_SESSION_STATUSES:
            record.status = AgentSessionStatus.WAITING_USER_INPUT
        status_after = str(record.status or "").strip()

        record.updated_at = now
        _save_session_record(conn, record)

        logger.info(
            "[AgentSessions] memory cleared: session_id=%s reason=%s"
            " status_before=%s status_after=%s message_count_before=%d",
            safe_session_id,
            safe_reason,
            status_before,
            status_after,
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

        now = utc_now()
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
                datetime_to_storage(now),
            ),
        )
        record.updated_at = now
        _touch_session_row(conn, safe_session_id, now)
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

        now = utc_now()
        pending_events = _load_pending_events(conn, safe_session_id)
        if not pending_events:
            return []
        conn.execute(
            "DELETE FROM agent_session_pending_events WHERE session_id = ?",
            (safe_session_id,),
        )
        _touch_session_row(conn, safe_session_id, now)
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
            _touch_session_row(conn, safe_session_id, utc_now())
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

        now = utc_now()
        _ = cancel_reason
        runtime = runtime_state(record.state_data)
        _validate_runtime_patch(runtime)
        runtime["session_activity_at"] = _session_activity_marker(now)
        record.state_data = _clean_session_storage_state({RUNTIME_KEY: runtime})

        record.status = AgentSessionStatus.CANCELLED
        record.updated_at = now

        _save_session_record(conn, record)
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

    keep_runtime_keys = {"session_activity_at"}

    with connection_scope() as conn:
        conn.execute("BEGIN IMMEDIATE")
        record = _load_session_record(conn, safe_session_id)
        if record is None:
            return None

        now = utc_now()
        _ = reset_reason
        runtime = runtime_state(record.state_data)
        _validate_runtime_patch(runtime)
        runtime["session_activity_at"] = _session_activity_marker(now)

        clear_session_messages(safe_session_id)

        reset_state = _compose_record_state(record, conn=conn)
        reset_state[RUNTIME_KEY] = runtime
        record.state_data = _clean_session_storage_state(
            reset_context_only(reset_state, keep_runtime_keys=keep_runtime_keys)
        )
        record.status = AgentSessionStatus.WAITING_USER_INPUT
        record.updated_at = now
        _save_session_record(conn, record)

    shutil.rmtree(_session_artifacts_dir(safe_session_id), ignore_errors=True)
    return load_agent_session(safe_session_id)


def reset_stuck_running_sessions() -> int:
    with connection_scope() as conn:
        conn.execute("BEGIN IMMEDIATE")
        now = datetime_to_storage(utc_now())
        result = conn.execute(
            """
            UPDATE agent_sessions
            SET status = ?,
                updated_at = ?
            WHERE status = ?
            """,
            (AgentSessionStatus.FAILED, now, AgentSessionStatus.RUNNING),
        )
        return int(result.rowcount or 0)


def cleanup_orphaned_agent_services() -> int:
    return 0


__all__ = [
    "append_agent_session_pending_event",
    "cancel_agent_session",
    "cleanup_orphaned_agent_services",
    "clear_agent_session_memory",
    "create_agent_session",
    "discard_agent_session_pending_event",
    "has_agent_session_pending_events",
    "load_agent_session",
    "pop_agent_session_pending_events",
    "request_agent_turn_stop",
    "reset_agent_session_context",
    "reset_stuck_running_sessions",
    "update_agent_session",
]
