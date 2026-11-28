from __future__ import annotations

import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from shared.repository import state_root


def database_path() -> Path:
    configured = str(os.getenv("LXE_SQLITE_DB_PATH") or "").strip()
    if configured:
        return Path(configured).expanduser()
    return state_root() / "db" / "lxeskill.sqlite3"


def connect(*, timeout: float = 5.0) -> sqlite3.Connection:
    path = database_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path), timeout=timeout)
    try:
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA journal_mode = WAL")
    except Exception:
        conn.close()
        raise
    return conn


@contextmanager
def connection_scope(*, timeout: float = 5.0) -> Iterator[sqlite3.Connection]:
    conn = connect(timeout=timeout)
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


__all__ = ["connect", "connection_scope", "database_path"]
