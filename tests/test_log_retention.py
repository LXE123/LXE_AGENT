from __future__ import annotations

from datetime import date
from pathlib import Path

import pytest

from shared.log_retention import (
    cleanup_local_logs,
    ensure_local_log_retention_once,
    local_log_retention_days,
    reset_local_log_retention_once_for_tests,
)


def _touch(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("x", encoding="utf-8")
    return path


def _mkdir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    _touch(path / "entry.txt")
    return path


def test_cleanup_local_logs_removes_only_expired_strict_date_entries(tmp_path, monkeypatch) -> None:
    monkeypatch.delenv("AGENT_STREAM_TRACE_DIR", raising=False)
    monkeypatch.delenv("AGENT_SSE_WIRE_TRACE_DIR", raising=False)
    monkeypatch.delenv("FEISHU_RAW_EVENT_DUMP_DIR", raising=False)
    old_file_date = "20260626"
    old_date = "20260627"
    cutoff_date = "20260628"
    current_date = "20260704"

    for relative_root in (
        "logs/agent_traces",
        "logs/sse_wire_traces",
        "logs/feishu_msg",
        "logs/runtime",
    ):
        root = tmp_path / relative_root
        _mkdir(root / old_date)
        _mkdir(root / cutoff_date)
        _mkdir(root / current_date)
        _mkdir(root / "not-a-date")
        _mkdir(root / "20261301")
        _touch(root / old_file_date)

    raw_root = tmp_path / "logs" / "feishu_raw_events"
    _touch(raw_root / f"{old_date}.jsonl")
    _touch(raw_root / f"{cutoff_date}.jsonl")
    _touch(raw_root / f"{current_date}.jsonl")
    _touch(raw_root / "not-a-date.jsonl")
    _touch(raw_root / "20261301.jsonl")
    _touch(raw_root / f"{old_date}.txt")

    result = cleanup_local_logs(
        retention_days=7,
        today=date(2026, 7, 4),
        repo_root=tmp_path,
    )

    assert result.cutoff_date == date(2026, 6, 28)
    assert result.retention_days == 7
    assert result.failed_paths == ()
    assert not (tmp_path / "logs" / "agent_traces" / old_date).exists()
    assert not (tmp_path / "logs" / "sse_wire_traces" / old_date).exists()
    assert not (tmp_path / "logs" / "feishu_msg" / old_date).exists()
    assert not (tmp_path / "logs" / "runtime" / old_date).exists()
    assert not (raw_root / f"{old_date}.jsonl").exists()

    for relative_root in (
        "logs/agent_traces",
        "logs/sse_wire_traces",
        "logs/feishu_msg",
        "logs/runtime",
    ):
        root = tmp_path / relative_root
        assert (root / cutoff_date).exists()
        assert (root / current_date).exists()
        assert (root / "not-a-date").exists()
        assert (root / "20261301").exists()
        assert (root / old_file_date).exists()

    assert (raw_root / f"{cutoff_date}.jsonl").exists()
    assert (raw_root / f"{current_date}.jsonl").exists()
    assert (raw_root / "not-a-date.jsonl").exists()
    assert (raw_root / "20261301.jsonl").exists()
    assert (raw_root / f"{old_date}.txt").exists()


@pytest.mark.parametrize("local_logs_enabled", [None, "0"])
def test_cleanup_local_logs_runs_regardless_of_local_logs_switch(
    tmp_path,
    monkeypatch,
    local_logs_enabled: str | None,
) -> None:
    if local_logs_enabled is None:
        monkeypatch.delenv("LOCAL_LOGS_ENABLED", raising=False)
    else:
        monkeypatch.setenv("LOCAL_LOGS_ENABLED", local_logs_enabled)
    old_path = _mkdir(tmp_path / "logs" / "agent_traces" / "20260601")

    cleanup_local_logs(retention_days=7, today=date(2026, 7, 4), repo_root=tmp_path)

    assert not old_path.exists()


def test_local_log_retention_days_defaults_to_seven_and_allows_override(monkeypatch) -> None:
    monkeypatch.delenv("LOCAL_LOG_RETENTION_DAYS", raising=False)
    assert local_log_retention_days() == 7

    monkeypatch.setenv("LOCAL_LOG_RETENTION_DAYS", "3")
    assert local_log_retention_days() == 3


def test_local_log_retention_days_clamps_to_at_least_one(monkeypatch) -> None:
    monkeypatch.setenv("LOCAL_LOG_RETENTION_DAYS", "0")

    assert local_log_retention_days() == 1


def test_ensure_local_log_retention_once_runs_only_once(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("AGENT_STREAM_TRACE_DIR", str(tmp_path / "logs" / "agent_traces"))
    monkeypatch.setenv("AGENT_SSE_WIRE_TRACE_DIR", str(tmp_path / "logs" / "sse_wire_traces"))
    monkeypatch.setenv("FEISHU_RAW_EVENT_DUMP_DIR", str(tmp_path / "logs" / "feishu_raw_events"))
    monkeypatch.setenv("LOCAL_LOG_RETENTION_DAYS", "7")
    reset_local_log_retention_once_for_tests()
    try:
        first = ensure_local_log_retention_once()
        second = ensure_local_log_retention_once()
    finally:
        reset_local_log_retention_once_for_tests()

    assert first is not None
    assert second is None
