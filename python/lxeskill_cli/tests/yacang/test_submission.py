from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from services.yacang.submission import YacangSubmissionStore, submission_key


def test_submission_marker_deduplicates_across_store_instances(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db_path = tmp_path / "lxeskill.sqlite3"
    monkeypatch.setenv("LXE_SQLITE_DB_PATH", str(db_path))
    key = submission_key(
        business_key="inventory-sales",
        warehouse_code="MY8801",
        start_date="2026-09-01",
        end_date="2026-09-13",
    )

    first_record, first_created = YacangSubmissionStore(clock=lambda: 1_000).acquire(
        key, {"old-one", "old-two"}
    )
    second_record, second_created = YacangSubmissionStore(clock=lambda: 1_001).acquire(
        key, {"different-baseline"}
    )

    assert first_created is True
    assert second_created is False
    assert second_record == first_record
    assert second_record.baseline_ids == {"old-one", "old-two"}

    with sqlite3.connect(db_path) as conn:
        columns = {
            str(row[1])
            for row in conn.execute("PRAGMA table_info(yacang_export_submissions)")
        }
        stored = conn.execute(
            "SELECT submission_key, state, baseline_ids_json FROM yacang_export_submissions"
        ).fetchone()
    assert columns == {"submission_key", "state", "baseline_ids_json", "updated_at"}
    assert stored == (key, "submitting", '["old-one","old-two"]')
