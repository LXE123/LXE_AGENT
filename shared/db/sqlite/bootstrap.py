from __future__ import annotations

from .engine import connection_scope, dispose


def init_schema() -> None:
    with connection_scope() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS card_owners (
                out_track_id TEXT PRIMARY KEY,
                owner_user_id TEXT NOT NULL,
                platform TEXT NOT NULL DEFAULT 'dingtalk',
                connector_key TEXT NOT NULL DEFAULT 'agent',
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
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS agent_contexts (
                context_id TEXT PRIMARY KEY,
                owner_user_id TEXT NOT NULL,
                platform TEXT NOT NULL DEFAULT 'dingtalk',
                connector_key TEXT NOT NULL DEFAULT 'agent',
                context_data TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                UNIQUE(platform, owner_user_id, connector_key)
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS agent_sessions (
                session_id TEXT PRIMARY KEY,
                context_id TEXT,
                card_id TEXT NOT NULL,
                owner_user_id TEXT NOT NULL,
                platform TEXT NOT NULL DEFAULT 'dingtalk',
                connector_key TEXT NOT NULL DEFAULT 'agent',
                conversation_id TEXT,
                conversation_type TEXT,
                sender_nick TEXT,
                status TEXT NOT NULL DEFAULT 'waiting_user_input',
                state_data TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(context_id) REFERENCES agent_contexts(context_id)
            )
            """
        )
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
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_card_owners_platform_message_id "
            "ON card_owners (platform_message_id)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_card_owners_owner_user_id "
            "ON card_owners (owner_user_id)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_ziniao_store_sessions_browser_id "
            "ON ziniao_store_sessions (browser_id)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_ziniao_store_sessions_updated_at "
            "ON ziniao_store_sessions (updated_at)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_agent_contexts_owner_user_id "
            "ON agent_contexts (owner_user_id)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_agent_contexts_platform "
            "ON agent_contexts (platform)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_agent_contexts_connector_key "
            "ON agent_contexts (connector_key)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_agent_sessions_context_id "
            "ON agent_sessions (context_id)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_agent_sessions_card_id "
            "ON agent_sessions (card_id)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_agent_sessions_owner_user_id "
            "ON agent_sessions (owner_user_id)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_agent_sessions_platform "
            "ON agent_sessions (platform)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_agent_sessions_connector_key "
            "ON agent_sessions (connector_key)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_agent_sessions_conversation_id "
            "ON agent_sessions (conversation_id)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_agent_sessions_status "
            "ON agent_sessions (status)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_agent_session_pending_events_session_queue "
            "ON agent_session_pending_events (session_id, queue_id)"
        )


__all__ = ["dispose", "init_schema"]
