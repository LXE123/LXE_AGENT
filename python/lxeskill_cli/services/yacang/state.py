"""Only non-secret submission/cooldown records; authentication lives in memory."""
from __future__ import annotations

from contextlib import contextmanager
import json
import os
from pathlib import Path
import sqlite3
import time
from shared.process_lock import interprocess_lock
from shared.repository import state_root
from .errors import YacangError


class ExportState:
    def __init__(self, account_id):
        self.account_id = account_id
        self.root = state_root() / "db" / "lxeskill" / "yacang"
        # Desktop injects its Python-owned database; never touch the Agent database.
        self.db = Path(os.getenv("LXE_SQLITE_DB_PATH") or state_root() / "db" / "lxeskill.sqlite3")

    @contextmanager
    def connection(self):
        self.db.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(self.db, timeout=10)
        try:
            conn.execute("CREATE TABLE IF NOT EXISTS yacang_submissions (key TEXT PRIMARY KEY, account TEXT NOT NULL, baseline TEXT NOT NULL, status TEXT NOT NULL)")
            conn.execute("CREATE TABLE IF NOT EXISTS yacang_cooldown (account TEXT PRIMARY KEY, until REAL NOT NULL)")
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def run_lock(self):
        # A second login on the same account may invalidate the first task's token.
        return interprocess_lock(self.root / f"account-{self.account_id}.lock", timeout_seconds=0)

    def task_lock(self, key):
        return interprocess_lock(self.root / f"{key}.lock", timeout_seconds=0)

    def pending(self, key):
        with self.connection() as conn:
            row = conn.execute("SELECT baseline FROM yacang_submissions WHERE key=? AND account=?", (key, self.account_id)).fetchone()
            return set(json.loads(row[0])) if row else None

    def begin(self, key, baseline):
        with self.connection() as conn:
            conn.execute("INSERT INTO yacang_submissions VALUES (?, ?, ?, ?)", (key, self.account_id, json.dumps(sorted(baseline)), "submitting"))

    def clear(self, key):
        with self.connection() as conn:
            conn.execute("DELETE FROM yacang_submissions WHERE key=? AND account=?", (key, self.account_id))

    def cooldown(self):
        with self.connection() as conn:
            conn.execute("INSERT OR REPLACE INTO yacang_cooldown VALUES (?, ?)", (self.account_id, time.time() + 900))

    @contextmanager
    def request_slot(self):
        # A held file lock has no expiring lease; even a slow request stays serialized.
        with interprocess_lock(self.root / "requests.lock", timeout_seconds=185):
            with self.connection() as conn:
                row = conn.execute("SELECT until FROM yacang_cooldown WHERE account=?", (self.account_id,)).fetchone()
            if row and row[0] > time.time():
                raise YacangError("限流等待", f"距离本地冷却结束还有 {int(row[0] - time.time()) + 1} 秒", code="rate_limited", scope="global")
            try:
                yield
            finally:
                time.sleep(1)
