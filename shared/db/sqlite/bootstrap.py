from __future__ import annotations

from .engine import connection_scope, dispose


def _create_response_routes(conn) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS response_routes (
            response_route_id TEXT PRIMARY KEY,
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
            model TEXT NOT NULL DEFAULT '',
            model_config TEXT NOT NULL DEFAULT '{}',
            created_at REAL NOT NULL,
            last_active_at REAL NOT NULL,
            message_count INTEGER NOT NULL DEFAULT 0,
            tool_call_count INTEGER NOT NULL DEFAULT 0,
            input_tokens INTEGER NOT NULL DEFAULT 0,
            output_tokens INTEGER NOT NULL DEFAULT 0,
            title TEXT NOT NULL DEFAULT '',
            api_call_count INTEGER NOT NULL DEFAULT 0
        )
        """
    )


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
        "CREATE INDEX IF NOT EXISTS idx_response_routes_platform_message_id "
        "ON response_routes (platform_message_id)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_response_routes_owner_user_id "
        "ON response_routes (owner_user_id)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_response_routes_platform "
        "ON response_routes (platform)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_agent_sessions_last_active_at "
        "ON agent_sessions (last_active_at)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_agent_sessions_model "
        "ON agent_sessions (model)"
    )


def init_schema() -> None:
    with connection_scope() as conn:
        _create_response_routes(conn)
        _create_ziniao_sessions(conn)
        _create_agent_sessions(conn)
        _create_pending_events(conn)
        _create_indexes(conn)
