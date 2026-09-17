from __future__ import annotations

import hashlib
import json
import time
from dataclasses import dataclass
from typing import Callable, Protocol

from shared.db.sqlite.engine import connection_scope


@dataclass(frozen=True)
class SubmissionRecord:
    key: str
    state: str
    baseline_ids: set[str]


class SubmissionBackend(Protocol):
    def acquire(self, key: str, baseline_ids: set[str]) -> tuple[SubmissionRecord, bool]: ...

    def set_state(self, key: str, state: str) -> None: ...

    def clear(self, key: str) -> None: ...


def submission_key(
    *,
    business_key: str,
    warehouse_code: str,
    start_date: str,
    end_date: str,
) -> str:
    raw = "\0".join((business_key, warehouse_code, start_date, end_date)).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


class YacangSubmissionStore:
    """Cross-process idempotency markers in the existing Python CLI database."""

    def __init__(self, *, clock: Callable[[], float] = time.time) -> None:
        self.clock = clock

    @staticmethod
    def _ensure_schema(conn: object) -> None:
        conn.execute(  # type: ignore[attr-defined]
            """
            CREATE TABLE IF NOT EXISTS yacang_export_submissions (
                submission_key TEXT PRIMARY KEY,
                state TEXT NOT NULL,
                baseline_ids_json TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            )
            """
        )

    def acquire(self, key: str, baseline_ids: set[str]) -> tuple[SubmissionRecord, bool]:
        now = int(self.clock())
        with connection_scope() as conn:
            self._ensure_schema(conn)
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT state, baseline_ids_json FROM yacang_export_submissions WHERE submission_key = ?",
                (key,),
            ).fetchone()
            if row is not None:
                stored = json.loads(str(row["baseline_ids_json"] or "[]"))
                return SubmissionRecord(key, str(row["state"]), {str(item) for item in stored}), False
            encoded = json.dumps(sorted(str(item) for item in baseline_ids), separators=(",", ":"))
            conn.execute(
                """
                INSERT INTO yacang_export_submissions(
                    submission_key, state, baseline_ids_json, updated_at
                ) VALUES (?, ?, ?, ?)
                """,
                (key, "submitting", encoded, now),
            )
            return SubmissionRecord(key, "submitting", set(baseline_ids)), True

    def set_state(self, key: str, state: str) -> None:
        with connection_scope() as conn:
            self._ensure_schema(conn)
            conn.execute(
                "UPDATE yacang_export_submissions SET state = ?, updated_at = ? WHERE submission_key = ?",
                (str(state), int(self.clock()), key),
            )

    def clear(self, key: str) -> None:
        with connection_scope() as conn:
            self._ensure_schema(conn)
            conn.execute(
                "DELETE FROM yacang_export_submissions WHERE submission_key = ?",
                (key,),
            )


class MemorySubmissionStore:
    def __init__(self) -> None:
        self.records: dict[str, SubmissionRecord] = {}

    def acquire(self, key: str, baseline_ids: set[str]) -> tuple[SubmissionRecord, bool]:
        existing = self.records.get(key)
        if existing is not None:
            return existing, False
        record = SubmissionRecord(key, "submitting", set(baseline_ids))
        self.records[key] = record
        return record, True

    def set_state(self, key: str, state: str) -> None:
        record = self.records.get(key)
        if record is not None:
            self.records[key] = SubmissionRecord(key, str(state), set(record.baseline_ids))

    def clear(self, key: str) -> None:
        self.records.pop(key, None)


__all__ = [
    "MemorySubmissionStore",
    "SubmissionBackend",
    "SubmissionRecord",
    "YacangSubmissionStore",
    "submission_key",
]
