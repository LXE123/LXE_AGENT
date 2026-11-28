"""Local outbox for lxeskill business command calls."""

from __future__ import annotations

import json
import os
import sqlite3
import time
from collections.abc import Callable
from concurrent.futures import Future
from datetime import UTC, datetime
from threading import Thread
from typing import Any
from uuid import uuid4

from shared.db.sqlite.engine import connection_scope
from shared.infra.cloud_client import CloudClient, CloudResponse, diagnostic, normalize_server_url
from shared.logging import get_logger

logger = get_logger(__name__)
BATCH_SIZE = 200
MAX_BATCHES = 3
UPLOAD_SECONDS = 2.0
BACKOFF_SECONDS = 600


def with_command_usage(entry: dict[str, Any], run: Callable[[], int]) -> int:
    skills = entry.get("owner_skills")
    if not skills:
        return run()

    try:
        occurred_at = datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        started = time.monotonic()
    except Exception as exc:
        _log_failure(exc)
        return run()
    ok = False
    try:
        code = run()
        ok = code == 0
        return code
    finally:
        try:
            duration_ms = round((time.monotonic() - started) * 1000)
            _record(" ".join(entry["command_path"]), skills, ok, duration_ms, occurred_at)
        except (Exception, KeyboardInterrupt) as exc:
            _log_failure(exc)


def _log_failure(exc: BaseException) -> None:
    # Even a broken diagnostic sink must preserve the business result.
    try:
        detail = diagnostic(f"{type(exc).__name__}: {exc}")
        logger.debug("command usage: %s", detail if len(detail) <= 256 else detail[:256] + " [truncated]")
    except Exception:
        pass


def _record(command: str, skills: list[str], ok: bool, duration_ms: int, occurred_at: str) -> None:
    # Avoid waiting behind business writes. Never hold a write transaction over HTTP.
    with connection_scope(timeout=0.05) as db:
        db.execute("""
            CREATE TABLE IF NOT EXISTS command_calls (
                event_id TEXT PRIMARY KEY NOT NULL, command TEXT NOT NULL, skills TEXT NOT NULL,
                ok INTEGER NOT NULL CHECK (ok IN (0, 1)), duration_ms INTEGER NOT NULL,
                occurred_at TEXT NOT NULL, uploaded_at REAL
            )
        """)
        db.execute("CREATE INDEX IF NOT EXISTS command_calls_queue ON command_calls(uploaded_at, occurred_at)")
        db.execute("""
            CREATE TABLE IF NOT EXISTS command_call_upload_state (
                singleton INTEGER PRIMARY KEY CHECK (singleton = 1), retry_after REAL NOT NULL
            )
        """)
        db.execute("""
            INSERT INTO command_calls(event_id, command, skills, ok, duration_ms, occurred_at)
            VALUES (?, ?, ?, ?, ?, ?)
        """, (str(uuid4()), command, json.dumps(skills), ok, duration_ms, occurred_at))
        db.execute("DELETE FROM command_calls WHERE uploaded_at < ?", (time.time() - 30 * 86400,))
        db.execute("""
            DELETE FROM command_calls WHERE rowid IN (
                SELECT rowid FROM command_calls WHERE uploaded_at IS NULL
                ORDER BY occurred_at DESC, rowid DESC LIMIT -1 OFFSET 5000
            )
        """)
        db.commit()
        server = os.getenv("LXE_DATA_SERVER_URL", "").strip()
        if server:
            _upload(db, normalize_server_url(server))


def _upload(db: sqlite3.Connection, server: str) -> None:
    deadline = time.monotonic() + UPLOAD_SECONDS
    for _ in range(MAX_BATCHES):
        if db.execute("SELECT 1 FROM command_call_upload_state WHERE retry_after > ?", (time.time(),)).fetchone():
            return
        rows = db.execute("""
            SELECT event_id, command, skills, ok, duration_ms, occurred_at FROM command_calls
            WHERE uploaded_at IS NULL ORDER BY occurred_at, rowid LIMIT ?
        """, (BATCH_SIZE,)).fetchall()
        if not rows or time.monotonic() >= deadline:
            return
        calls = [dict(row, skills=json.loads(row["skills"]), ok=bool(row["ok"])) for row in rows]
        try:
            response = _post(server, calls, deadline)
            if response.status_code != 200:
                raise ValueError(f"command-calls returned HTTP {response.status_code}")
            ack = response.payload
            if response.truncated or not response.json_valid or not isinstance(ack, dict):
                raise ValueError("command-calls ACK is incomplete or is not a JSON object")
            counts = (ack.get("accepted"), ack.get("duplicates"))
            if not all(type(n) is int and n >= 0 for n in counts):
                raise ValueError("command-calls ACK requires nonnegative integer accepted and duplicates counts")
            if sum(counts) != len(calls):
                raise ValueError(f"command-calls ACK accepted {counts[0]} plus {counts[1]} duplicates for {len(calls)} calls")
        except Exception:
            db.execute("""
                INSERT INTO command_call_upload_state(singleton, retry_after) VALUES (1, ?)
                ON CONFLICT(singleton) DO UPDATE SET retry_after = MAX(retry_after, excluded.retry_after)
            """, (time.time() + BACKOFF_SECONDS,))
            db.commit()
            raise
        uploaded_at = time.time()
        db.executemany("UPDATE command_calls SET uploaded_at = ? WHERE event_id = ? AND uploaded_at IS NULL",
                       [(uploaded_at, call["event_id"]) for call in calls])
        db.commit()
        if len(calls) < BATCH_SIZE:
            return


def _post(server: str, calls: list[dict], deadline: float) -> CloudResponse:
    # A socket timeout applies to each read and cannot bound DNS or a trickling
    # response. Only this daemon thread touches HTTP; a late ACK cannot change SQLite.
    result: Future[CloudResponse] = Future()

    def send() -> None:
        try:
            client = CloudClient(server, timeout=deadline - time.monotonic(), max_response_bytes=4096)
            result.set_result(client.request_json("POST", "/api/v1/lxeskill/command-calls", json_body={"calls": calls}))
        except Exception as exc:
            result.set_exception(exc)

    Thread(target=send, name="lxeskill-command-calls", daemon=True).start()
    return result.result(timeout=max(0.0, deadline - time.monotonic()))
