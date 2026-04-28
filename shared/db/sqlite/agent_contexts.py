from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from sqlite3 import Connection, Row
from typing import Any, Optional
from uuid import uuid4

from shared.agent_state import CONTEXT_KEY, MESSAGES_KEY, context_state
from shared.db.shared_state_dto import AgentContextState

from ._agent_storage import (
    datetime_from_storage,
    datetime_to_storage,
    json_object_from_storage,
    json_object_to_storage,
    sanitize_json_for_storage,
    utc_now,
)
from .engine import connection_scope


@dataclass
class AgentContextRecord:
    context_id: str
    owner_user_id: str
    platform: str
    connector_key: str
    context_data: dict[str, Any]
    created_at: Optional[datetime]
    updated_at: Optional[datetime]


def _clean_context_data(value: dict[str, Any] | None) -> dict[str, Any]:
    return sanitize_json_for_storage(context_state({CONTEXT_KEY: dict(value or {})}))


def _clean_context_patch(value: dict[str, Any] | None) -> dict[str, Any]:
    raw = dict(sanitize_json_for_storage(value) or {})
    cleaned: dict[str, Any] = {}
    if MESSAGES_KEY in raw:
        cleaned[MESSAGES_KEY] = list(raw.get(MESSAGES_KEY) or [])
    return cleaned


def _normalize_platform(value: Any) -> str:
    return str(value or "").strip() or "dingtalk"


def _normalize_connector_key(value: Any) -> str:
    return str(value or "").strip() or "agent"


def _record_from_row(row: Row | None) -> AgentContextRecord | None:
    if row is None:
        return None
    return AgentContextRecord(
        context_id=str(row["context_id"]),
        owner_user_id=str(row["owner_user_id"]),
        platform=_normalize_platform(row["platform"]),
        connector_key=_normalize_connector_key(row["connector_key"]),
        context_data=json_object_from_storage(
            row["context_data"],
            field_name="agent_contexts.context_data",
        ),
        created_at=datetime_from_storage(row["created_at"]),
        updated_at=datetime_from_storage(row["updated_at"]),
    )


def _to_state(record: AgentContextRecord) -> AgentContextState:
    return AgentContextState(
        context_id=str(record.context_id),
        owner_user_id=str(record.owner_user_id),
        platform=_normalize_platform(record.platform),
        connector_key=_normalize_connector_key(record.connector_key),
        context_data=_clean_context_data(dict(record.context_data or {})),
        created_at=record.created_at,
        updated_at=record.updated_at,
    )


def _load_agent_context_record(
    conn: Connection,
    *,
    context_id: str = "",
    owner_user_id: str = "",
    platform: str | None = None,
    connector_key: str | None = None,
) -> Optional[AgentContextRecord]:
    safe_context_id = str(context_id or "").strip()
    if safe_context_id:
        row = conn.execute(
            "SELECT * FROM agent_contexts WHERE context_id = ?",
            (safe_context_id,),
        ).fetchone()
        return _record_from_row(row)

    safe_owner_user_id = str(owner_user_id or "").strip()
    if not safe_owner_user_id:
        return None

    conditions = ["owner_user_id = ?"]
    params: list[Any] = [safe_owner_user_id]
    if platform:
        conditions.append("platform = ?")
        params.append(str(platform).strip())
    if connector_key:
        conditions.append("connector_key = ?")
        params.append(str(connector_key).strip())

    row = conn.execute(
        f"""
        SELECT * FROM agent_contexts
        WHERE {" AND ".join(conditions)}
        ORDER BY updated_at DESC, created_at DESC
        LIMIT 1
        """,
        tuple(params),
    ).fetchone()
    return _record_from_row(row)


def _insert_agent_context_record(conn: Connection, record: AgentContextRecord) -> None:
    conn.execute(
        """
        INSERT INTO agent_contexts (
            context_id,
            owner_user_id,
            platform,
            connector_key,
            context_data,
            created_at,
            updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            record.context_id,
            record.owner_user_id,
            _normalize_platform(record.platform),
            _normalize_connector_key(record.connector_key),
            json_object_to_storage(
                _clean_context_data(record.context_data),
                field_name="agent_contexts.context_data",
            ),
            datetime_to_storage(record.created_at or utc_now()),
            datetime_to_storage(record.updated_at or utc_now()),
        ),
    )


def _save_agent_context_record(conn: Connection, record: AgentContextRecord) -> None:
    conn.execute(
        """
        UPDATE agent_contexts
        SET owner_user_id = ?,
            platform = ?,
            connector_key = ?,
            context_data = ?,
            updated_at = ?
        WHERE context_id = ?
        """,
        (
            record.owner_user_id,
            _normalize_platform(record.platform),
            _normalize_connector_key(record.connector_key),
            json_object_to_storage(
                _clean_context_data(record.context_data),
                field_name="agent_contexts.context_data",
            ),
            datetime_to_storage(record.updated_at or utc_now()),
            record.context_id,
        ),
    )


def _touch_agent_context_record(record: AgentContextRecord, *, base_time: Optional[datetime] = None) -> None:
    record.updated_at = base_time or utc_now()


def _ensure_agent_context_record(
    conn: Connection,
    *,
    owner_user_id: str,
    platform: str,
    connector_key: str,
    initial_context_data: dict[str, Any] | None = None,
) -> AgentContextRecord:
    record = _load_agent_context_record(
        conn,
        owner_user_id=owner_user_id,
        platform=platform,
        connector_key=connector_key,
    )
    if record is not None:
        _touch_agent_context_record(record)
        _save_agent_context_record(conn, record)
        return record

    now = utc_now()
    record = AgentContextRecord(
        context_id=uuid4().hex,
        owner_user_id=str(owner_user_id or "").strip(),
        platform=_normalize_platform(platform),
        connector_key=_normalize_connector_key(connector_key),
        context_data=_clean_context_data(initial_context_data),
        created_at=now,
        updated_at=now,
    )
    _insert_agent_context_record(conn, record)
    return record


def _apply_agent_context_patch(
    record: AgentContextRecord,
    context_patch: dict[str, Any] | None,
    *,
    base_time: Optional[datetime] = None,
) -> None:
    if context_patch:
        merged = _clean_context_data(dict(record.context_data or {}))
        merged.update(_clean_context_patch(context_patch))
        record.context_data = _clean_context_data(merged)
    _touch_agent_context_record(record, base_time=base_time)


def load_agent_context(context_id: str) -> Optional[AgentContextState]:
    safe_context_id = str(context_id or "").strip()
    if not safe_context_id:
        return None
    with connection_scope() as conn:
        record = _load_agent_context_record(conn, context_id=safe_context_id)
        return _to_state(record) if record is not None else None


def load_agent_context_by_user(
    owner_user_id: str,
    *,
    platform: str | None = None,
    connector_key: str | None = None,
) -> Optional[AgentContextState]:
    safe_owner_user_id = str(owner_user_id or "").strip()
    if not safe_owner_user_id:
        return None
    with connection_scope() as conn:
        record = _load_agent_context_record(
            conn,
            owner_user_id=safe_owner_user_id,
            platform=platform,
            connector_key=connector_key,
        )
        return _to_state(record) if record is not None else None


def upsert_agent_context(
    *,
    owner_user_id: str,
    platform: str,
    connector_key: str,
    context_data: dict[str, Any] | None = None,
) -> AgentContextState:
    safe_owner_user_id = str(owner_user_id or "").strip()
    if not safe_owner_user_id:
        raise RuntimeError("owner_user_id required")
    with connection_scope() as conn:
        conn.execute("BEGIN IMMEDIATE")
        record = _ensure_agent_context_record(
            conn,
            owner_user_id=safe_owner_user_id,
            platform=_normalize_platform(platform),
            connector_key=_normalize_connector_key(connector_key),
            initial_context_data=context_data,
        )
        return _to_state(record)


def update_agent_context(
    context_id: str,
    *,
    context_patch: dict[str, Any] | None = None,
) -> Optional[AgentContextState]:
    safe_context_id = str(context_id or "").strip()
    if not safe_context_id:
        return None
    with connection_scope() as conn:
        conn.execute("BEGIN IMMEDIATE")
        record = _load_agent_context_record(conn, context_id=safe_context_id)
        if record is None:
            return None
        _apply_agent_context_patch(record, context_patch)
        _save_agent_context_record(conn, record)
        return _to_state(record)


__all__ = [
    "AgentContextRecord",
    "load_agent_context",
    "load_agent_context_by_user",
    "upsert_agent_context",
    "update_agent_context",
    "_apply_agent_context_patch",
    "_clean_context_data",
    "_clean_context_patch",
    "_ensure_agent_context_record",
    "_load_agent_context_record",
    "_save_agent_context_record",
    "_touch_agent_context_record",
    "_to_state",
]
