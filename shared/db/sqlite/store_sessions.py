from __future__ import annotations

import socket
from datetime import datetime, timezone
from sqlite3 import Row
from typing import Any

from shared.db.shared_state_dto import ZiniaoStoreSessionState

from .engine import connection_scope


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _datetime_to_storage(value: datetime) -> str:
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat()


def _datetime_from_storage(value: Any) -> datetime | None:
    text = str(value or "").strip()
    if not text:
        return None
    return datetime.fromisoformat(text)


def browser_host_id(host_id: str | None = None) -> str:
    safe_host_id = str(host_id or "").strip()
    if safe_host_id:
        return safe_host_id
    derived = str(socket.gethostname() or "").strip()
    return derived or "local"


def _safe_browser_oauth(value: Any) -> str:
    text = str(value or "").strip()
    if not text:
        raise RuntimeError("browser_oauth required")
    return text


def _safe_browser_name(value: Any) -> str:
    return str(value or "").strip()


def _safe_browser_id(value: Any) -> int:
    safe_value = int(value or 0)
    if safe_value <= 0:
        raise RuntimeError("browser_id required")
    return safe_value


def _safe_debugging_port(value: Any) -> int:
    safe_value = int(value or 0)
    if safe_value <= 0:
        raise RuntimeError("debugging_port required")
    return safe_value


def _safe_required_path(field_name: str, value: Any) -> str:
    text = str(value or "").strip()
    if not text:
        raise RuntimeError(f"{field_name} required")
    return text


def _to_state(row: Row | None, *, host_id: str) -> ZiniaoStoreSessionState | None:
    if row is None:
        return None
    return ZiniaoStoreSessionState(
        host_id=str(row["host_id"] or "").strip() or host_id,
        browser_oauth=str(row["browser_oauth"] or "").strip(),
        browser_id=int(row["browser_id"] or 0),
        browser_name=str(row["browser_name"] or "").strip(),
        debugging_port=int(row["debugging_port"] or 0),
        download_path=str(row["download_path"] or "").strip(),
        browser_path=str(row["browser_path"] or "").strip(),
        created_at=_datetime_from_storage(row["created_at"]),
        updated_at=_datetime_from_storage(row["updated_at"]),
    )


def load_store_session(browser_oauth: str, *, host_id: str | None = None) -> ZiniaoStoreSessionState | None:
    safe_host_id = browser_host_id(host_id)
    safe_browser_oauth = _safe_browser_oauth(browser_oauth)
    with connection_scope() as conn:
        row = conn.execute(
            """
            SELECT * FROM ziniao_store_sessions
            WHERE host_id = ? AND browser_oauth = ?
            """,
            (safe_host_id, safe_browser_oauth),
        ).fetchone()
        return _to_state(row, host_id=safe_host_id)


def list_store_sessions(*, host_id: str | None = None) -> list[ZiniaoStoreSessionState]:
    safe_host_id = browser_host_id(host_id)
    with connection_scope() as conn:
        rows = conn.execute(
            """
            SELECT * FROM ziniao_store_sessions
            WHERE host_id = ?
            ORDER BY updated_at DESC, browser_oauth ASC
            """,
            (safe_host_id,),
        ).fetchall()
        return [state for row in rows if (state := _to_state(row, host_id=safe_host_id)) is not None]


def upsert_store_session(
    *,
    browser_oauth: str,
    browser_id: int,
    browser_name: str,
    debugging_port: int,
    download_path: str,
    browser_path: str,
    host_id: str | None = None,
) -> ZiniaoStoreSessionState:
    safe_host_id = browser_host_id(host_id)
    safe_browser_oauth = _safe_browser_oauth(browser_oauth)
    safe_browser_id = _safe_browser_id(browser_id)
    safe_browser_name = _safe_browser_name(browser_name) or safe_browser_oauth
    safe_debugging_port = _safe_debugging_port(debugging_port)
    safe_download_path = _safe_required_path("download_path", download_path)
    safe_browser_path = _safe_required_path("browser_path", browser_path)
    now = _datetime_to_storage(_utc_now())

    with connection_scope() as conn:
        conn.execute(
            """
            INSERT INTO ziniao_store_sessions (
                host_id,
                browser_oauth,
                browser_id,
                browser_name,
                debugging_port,
                download_path,
                browser_path,
                created_at,
                updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(host_id, browser_oauth) DO UPDATE SET
                browser_id = excluded.browser_id,
                browser_name = excluded.browser_name,
                debugging_port = excluded.debugging_port,
                download_path = excluded.download_path,
                browser_path = excluded.browser_path,
                updated_at = excluded.updated_at
            """,
            (
                safe_host_id,
                safe_browser_oauth,
                safe_browser_id,
                safe_browser_name,
                safe_debugging_port,
                safe_download_path,
                safe_browser_path,
                now,
                now,
            ),
        )
        row = conn.execute(
            """
            SELECT * FROM ziniao_store_sessions
            WHERE host_id = ? AND browser_oauth = ?
            """,
            (safe_host_id, safe_browser_oauth),
        ).fetchone()
        state = _to_state(row, host_id=safe_host_id)
        if state is None:
            raise RuntimeError("failed to persist ziniao store session")
        return state


def delete_store_session(browser_oauth: str, *, host_id: str | None = None) -> bool:
    safe_host_id = browser_host_id(host_id)
    safe_browser_oauth = _safe_browser_oauth(browser_oauth)
    with connection_scope() as conn:
        result = conn.execute(
            """
            DELETE FROM ziniao_store_sessions
            WHERE host_id = ? AND browser_oauth = ?
            """,
            (safe_host_id, safe_browser_oauth),
        )
        return bool(result.rowcount or 0)


def clear_store_sessions(*, host_id: str | None = None) -> int:
    safe_host_id = browser_host_id(host_id)
    with connection_scope() as conn:
        result = conn.execute(
            "DELETE FROM ziniao_store_sessions WHERE host_id = ?",
            (safe_host_id,),
        )
        return int(result.rowcount or 0)


__all__ = [
    "browser_host_id",
    "clear_store_sessions",
    "delete_store_session",
    "list_store_sessions",
    "load_store_session",
    "upsert_store_session",
]
