from __future__ import annotations

import json
import os
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path

from gateway import planned_stop


def _isolate_paths(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(planned_stop, "RUNTIME_DIR", tmp_path)
    monkeypatch.setattr(planned_stop, "STATUS_PATH", tmp_path / "gateway-status.json")
    monkeypatch.setattr(planned_stop, "MARKER_PATH", tmp_path / "gateway-planned-stop.json")


def test_status_and_marker_round_trip(monkeypatch, tmp_path):
    _isolate_paths(monkeypatch, tmp_path)

    status = planned_stop.write_gateway_status("boot-a")
    assert status["pid"] == os.getpid()
    assert status["boot_id"] == "boot-a"
    assert planned_stop.read_gateway_status()["boot_id"] == "boot-a"

    marker = planned_stop.write_planned_stop_marker(status)
    assert marker["target_pid"] == os.getpid()
    assert marker["target_boot_id"] == "boot-a"
    assert planned_stop.planned_stop_marker_targets_self("boot-a") is True
    assert planned_stop.consume_planned_stop_marker_for_self("boot-a") is True
    assert not planned_stop.MARKER_PATH.exists()


def test_marker_must_match_pid_and_boot_id(monkeypatch, tmp_path):
    _isolate_paths(monkeypatch, tmp_path)

    now = datetime.now(timezone.utc).isoformat()
    planned_stop.MARKER_PATH.parent.mkdir(parents=True, exist_ok=True)
    planned_stop.MARKER_PATH.write_text(
        json.dumps(
            {
                "target_pid": os.getpid(),
                "target_boot_id": "old-boot",
                "requester_pid": os.getpid(),
                "requested_at": now,
            }
        ),
        encoding="utf-8",
    )

    assert planned_stop.planned_stop_marker_targets_self("new-boot") is False
    assert planned_stop.consume_planned_stop_marker_for_self("new-boot") is False
    assert not planned_stop.MARKER_PATH.exists()


def test_expired_marker_is_ignored_and_removed(monkeypatch, tmp_path):
    _isolate_paths(monkeypatch, tmp_path)

    expired_at = (datetime.now(timezone.utc) - timedelta(seconds=60)).isoformat()
    planned_stop.MARKER_PATH.parent.mkdir(parents=True, exist_ok=True)
    planned_stop.MARKER_PATH.write_text(
        json.dumps(
            {
                "target_pid": os.getpid(),
                "target_boot_id": "boot-a",
                "requester_pid": os.getpid(),
                "requested_at": expired_at,
            }
        ),
        encoding="utf-8",
    )

    assert planned_stop.planned_stop_marker_targets_self("boot-a", marker_ttl_seconds=1) is False
    assert planned_stop.consume_planned_stop_marker_for_self("boot-a", marker_ttl_seconds=1) is False
    assert not planned_stop.MARKER_PATH.exists()


def test_clear_status_only_removes_current_boot(monkeypatch, tmp_path):
    _isolate_paths(monkeypatch, tmp_path)

    planned_stop.write_gateway_status("boot-a")
    planned_stop.clear_gateway_status("boot-b")
    assert planned_stop.STATUS_PATH.exists()

    planned_stop.clear_gateway_status("boot-a")
    assert not planned_stop.STATUS_PATH.exists()


def test_request_gateway_stop_reports_missing_status(monkeypatch, tmp_path):
    _isolate_paths(monkeypatch, tmp_path)

    result = planned_stop.request_gateway_stop(timeout_s=1)
    assert result.success is False
    assert "status file not found" in result.message


def test_watcher_schedules_shutdown_once(monkeypatch, tmp_path):
    _isolate_paths(monkeypatch, tmp_path)

    status = planned_stop.write_gateway_status("boot-a")
    planned_stop.write_planned_stop_marker(status)
    calls = []

    class FakeLoop:
        def is_closed(self):
            return False

        def call_soon_threadsafe(self, callback):
            calls.append(callback)

    stop_event = threading.Event()
    watcher = threading.Thread(
        target=planned_stop.run_planned_stop_watcher,
        kwargs={
            "stop_event": stop_event,
            "boot_id": "boot-a",
            "loop": FakeLoop(),
            "request_shutdown": lambda: calls.append("shutdown"),
            "poll_interval": 0.01,
        },
        daemon=True,
    )
    watcher.start()
    watcher.join(timeout=1.0)

    assert not watcher.is_alive()
    assert len(calls) == 1
    assert callable(calls[0])
    calls[0]()
    assert calls == [calls[0], "shutdown"]


def test_launcher_exposes_stop_command():
    root = Path(__file__).resolve().parents[1]
    source = (root / "scripts" / "launcher.ps1").read_text(encoding="utf-8-sig")
    assert "function Invoke-LxeStop" in source
    assert '"stop" { Invoke-LxeStop }' in source
    assert "LXE <start|stop|doctor|update>" in source
