from __future__ import annotations

def ensure_ziniao_schema(conn) -> None:
    """Create the Python-owned ziniao session table on demand.

    The Bun gateway bootstraps every table it owns; this is the only table
    owned by the Python side, so standalone CLI entrypoints create it on
    demand without touching Bun-owned runtime tables.
    """
    _create_ziniao_sessions(conn)


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
            core_type TEXT NOT NULL DEFAULT '',
            core_version TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (host_id, browser_oauth)
        )
        """
    )
    _ensure_column(conn, "ziniao_store_sessions", "core_type", "TEXT NOT NULL DEFAULT ''")
    _ensure_column(conn, "ziniao_store_sessions", "core_version", "TEXT NOT NULL DEFAULT ''")


def _ensure_column(conn, table_name: str, column_name: str, column_sql: str) -> None:
    existing = {
        str(row["name"] if hasattr(row, "keys") else row[1])
        for row in conn.execute(f"PRAGMA table_info({table_name})").fetchall()
    }
    if column_name in existing:
        return
    conn.execute(f"ALTER TABLE {table_name} ADD COLUMN {column_name} {column_sql}")
