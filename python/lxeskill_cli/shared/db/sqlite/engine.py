from __future__ import annotations

import os
import sqlite3
from contextlib import closing, contextmanager
from pathlib import Path
from typing import Iterator
from uuid import uuid4

from shared.process_lock import interprocess_lock
from shared.repository import state_root

_PYTHON_TABLES = (
    "ziniao_store_sessions",
    "yacang_provider_cooldowns",
    "yacang_request_gate",
    "yacang_export_submissions",
)


def database_path() -> Path:
    configured = str(os.getenv("LXE_SQLITE_DB_PATH") or "").strip()
    if configured:
        return Path(configured).expanduser()
    return state_root() / "db" / "lxeskill.sqlite3"


def _migrate_default_database(path: Path) -> None:
    """Copy only Python-owned tables from a legacy SQLite snapshot, including WAL changes.

    The source remains intact as a rollback copy. Explicitly configured paths
    are never migrated; production Desktop already selects lxeskill.sqlite3.
    """
    if str(os.getenv("LXE_SQLITE_DB_PATH") or "").strip() or path.exists():
        return
    legacy = path.with_name("local_agent.sqlite3")
    if not legacy.is_file():
        return
    with interprocess_lock(path.with_name("lxeskill.migration.lock"), timeout_seconds=10):
        if path.exists() or not legacy.is_file():
            return
        temporary = path.with_name(f".{path.name}.{uuid4().hex}.migrating")
        try:
            with closing(sqlite3.connect(f"{legacy.resolve().as_uri()}?mode=ro", uri=True)) as source:
                with closing(sqlite3.connect(str(temporary))) as destination:
                    for table in _PYTHON_TABLES:
                        row = source.execute(
                            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", (table,)
                        ).fetchone()
                        if row is None:
                            continue
                        destination.execute(row[0])
                        columns = source.execute(f'PRAGMA table_info("{table}")').fetchall()
                        placeholders = ", ".join("?" for _ in columns)
                        destination.executemany(
                            f'INSERT INTO "{table}" VALUES ({placeholders})',
                            source.execute(f'SELECT * FROM "{table}"'),
                        )
                    destination.commit()
                    if destination.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                        raise sqlite3.DatabaseError("migrated lxeskill database failed integrity check")
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)


def connect() -> sqlite3.Connection:
    path = database_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    _migrate_default_database(path)
    conn = sqlite3.connect(str(path), timeout=5.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 5000")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


@contextmanager
def connection_scope() -> Iterator[sqlite3.Connection]:
    conn = connect()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


__all__ = ["connect", "connection_scope", "database_path"]
