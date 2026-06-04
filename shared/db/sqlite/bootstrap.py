from __future__ import annotations

import json
from typing import Any

from shared.session_bindings import SessionBindingStore, SessionSource

from .engine import connection_scope, dispose


_LEGACY_ROUTE_COLUMN = "connector" + "_key"


def _table_exists(conn, name: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
        (name,),
    ).fetchone()
    return row is not None


def _columns(conn, table: str) -> set[str]:
    if not _table_exists(conn, table):
        return set()
    return {str(row["name"]) for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}


def _create_card_owners(conn) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS card_owners (
            out_track_id TEXT PRIMARY KEY,
            owner_user_id TEXT NOT NULL,
            platform TEXT NOT NULL DEFAULT 'feishu',
            platform_message_id TEXT,
            conversation_id TEXT,
            conversation_type TEXT,
            sender_nick TEXT,
            extra_data TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        """
    )


def _create_agent_sessions(conn) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS agent_sessions (
            session_id TEXT PRIMARY KEY,
            source TEXT NOT NULL DEFAULT '{}',
            status TEXT NOT NULL DEFAULT 'waiting_user_input',
            state_data TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        """
    )


def _source_from_legacy_session(row: Any) -> dict[str, Any]:
    platform = str(row["platform"] or "feishu").strip() or "feishu"
    chat_id = str(row["conversation_id"] or "").strip()
    conversation_type = str(row["conversation_type"] or "").strip()
    chat_type = "group" if conversation_type == "2" else "dm"
    user_id = str(row["owner_user_id"] or "").strip()
    sender_nick = str(row["sender_nick"] or "").strip()
    source = SessionSource(
        platform=platform,
        chat_id=chat_id or "unknown",
        chat_type=chat_type,
        user_id=user_id,
        user_name=sender_nick,
        chat_name=chat_id,
    )
    return source.to_dict()


def _migrate_card_owners(conn) -> None:
    if not _table_exists(conn, "card_owners"):
        _create_card_owners(conn)
        return
    cols = _columns(conn, "card_owners")
    if _LEGACY_ROUTE_COLUMN not in cols:
        return
    conn.execute("ALTER TABLE card_owners RENAME TO card_owners_legacy")
    _create_card_owners(conn)
    conn.execute(
        """
        INSERT INTO card_owners (
            out_track_id,
            owner_user_id,
            platform,
            platform_message_id,
            conversation_id,
            conversation_type,
            sender_nick,
            extra_data,
            created_at,
            updated_at
        )
        SELECT
            out_track_id,
            owner_user_id,
            platform,
            platform_message_id,
            conversation_id,
            conversation_type,
            sender_nick,
            extra_data,
            created_at,
            updated_at
        FROM card_owners_legacy
        """
    )
    conn.execute("DROP TABLE card_owners_legacy")


def _drop_agent_contexts(conn) -> None:
    conn.execute("DROP TABLE IF EXISTS agent_contexts")


def _write_legacy_bindings(rows: list[Any]) -> None:
    if not rows:
        return
    store = SessionBindingStore()
    entries = store.load_all()
    changed = False
    for row in rows:
        source = SessionSource.from_dict(_source_from_legacy_session(row))
        try:
            session_key = source.session_key
        except RuntimeError:
            continue
        if session_key in entries:
            continue
        entries[session_key] = store.bind(source, session_id=str(row["session_id"]))
        changed = True
    if changed:
        store.save_all(entries)


def _json_object_from_text(value: Any) -> dict[str, Any]:
    try:
        parsed = json.loads(str(value or "{}"))
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _migrate_agent_sessions(conn) -> None:
    if not _table_exists(conn, "agent_sessions"):
        _create_agent_sessions(conn)
        return
    cols = _columns(conn, "agent_sessions")
    if "source" in cols and _LEGACY_ROUTE_COLUMN not in cols and "card_id" not in cols and "context_id" not in cols:
        return
    legacy_rows = conn.execute("SELECT * FROM agent_sessions").fetchall()
    if "source" not in cols:
        _write_legacy_bindings(legacy_rows)
    conn.execute("DROP TABLE IF EXISTS agent_session_pending_events")
    conn.execute("ALTER TABLE agent_sessions RENAME TO agent_sessions_legacy")
    _create_agent_sessions(conn)
    for row in legacy_rows:
        source = _json_object_from_text(row["source"]) if "source" in cols else _source_from_legacy_session(row)
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
                row["session_id"],
                json.dumps(source, ensure_ascii=False, separators=(",", ":")),
                row["status"],
                row["state_data"],
                row["created_at"],
                row["updated_at"],
            ),
        )
    conn.execute("DROP TABLE agent_sessions_legacy")


def _create_pending_events(conn) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS agent_session_pending_events (
            queue_id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            event_id TEXT NOT NULL UNIQUE,
            job_id TEXT NOT NULL,
            created_at TEXT NOT NULL,
            text TEXT NOT NULL,
            queued_at TEXT NOT NULL,
            FOREIGN KEY(session_id) REFERENCES agent_sessions(session_id) ON DELETE CASCADE
        )
        """
    )


def _create_ziniao_sessions(conn) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS ziniao_store_sessions (
            host_id TEXT NOT NULL,
            browser_oauth TEXT NOT NULL,
            browser_id INTEGER NOT NULL,
            browser_name TEXT NOT NULL DEFAULT '',
            debugging_port INTEGER NOT NULL DEFAULT 0,
            download_path TEXT NOT NULL DEFAULT '',
            browser_path TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (host_id, browser_oauth)
        )
        """
    )


def _create_indexes(conn) -> None:
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_card_owners_platform_message_id "
        "ON card_owners (platform_message_id)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_card_owners_owner_user_id "
        "ON card_owners (owner_user_id)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_card_owners_platform "
        "ON card_owners (platform)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_agent_sessions_status "
        "ON agent_sessions (status)"
    )


def init_schema() -> None:
    with connection_scope() as conn:
        _migrate_card_owners(conn)
        _migrate_agent_sessions(conn)
        _drop_agent_contexts(conn)
        _create_card_owners(conn)
        _create_ziniao_sessions(conn)
        _create_agent_sessions(conn)
        _create_pending_events(conn)
        _create_indexes(conn)
