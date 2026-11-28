from __future__ import annotations

import io
import json
import logging
import re
import time
from datetime import UTC, datetime, timedelta
from threading import Event
from uuid import UUID

import pytest

from lxeskill import cli, usage
from shared.db.sqlite.engine import connection_scope
from shared.infra import cloud_client

COMMAND = ["replenish", "store", "resolve"]
ARGV = [*COMMAND, "--store-name", "private-store"]
SERVER = "https://telemetry.test"


@pytest.fixture(autouse=True)
def isolated_cli(tmp_path, monkeypatch):
    monkeypatch.setenv("LXE_SQLITE_DB_PATH", str(tmp_path / "lxeskill.sqlite3"))
    monkeypatch.delenv("LXE_DATA_SERVER_URL", raising=False)
    monkeypatch.delenv("LXESKILL_SKILL_SCOPE", raising=False)
    monkeypatch.setattr(cli, "activate_project_workspace", lambda: None)
    monkeypatch.setattr(cli, "setup_logging", lambda: None)
    monkeypatch.setattr(cli, "execute_module_json", lambda *a, **kw: (True, [], [], None))
    attempts = []

    def unexpected_client(*args):
        attempts.append(True)
        raise AssertionError("unexpected HTTP client")

    monkeypatch.setattr(cloud_client, "build_opener", unexpected_client)
    yield
    assert not attempts


def rows():
    with connection_scope() as db:
        return [dict(row) for row in db.execute("SELECT * FROM command_calls ORDER BY occurred_at, rowid")]


def http(monkeypatch, reply):
    class Opener:
        def open(self, req, *, timeout):
            assert req.full_url == SERVER + "/api/v1/lxeskill/command-calls"
            assert req.get_method() == "POST"
            assert req.get_header("X-lxe-client") == "cli"
            assert 0 < timeout <= 2
            body = json.loads(req.data)
            assert set(body) == {"calls"}
            status, data = reply(body["calls"])
            raw = data if isinstance(data, bytes) else json.dumps(data).encode()
            response = io.BytesIO(raw)
            response.code = status
            response.headers = {}
            return response

    monkeypatch.setenv("LXE_DATA_SERVER_URL", SERVER + "/")
    monkeypatch.setattr(cloud_client, "build_opener", lambda *args: Opener())


def test_records_one_canonical_call_from_alias_without_arguments(capsys):
    before = datetime.now(UTC) - timedelta(milliseconds=1)
    assert cli.main(["mabang_resolve_fba_store", *ARGV[3:]]) == 0
    assert json.loads(capsys.readouterr().out)["ok"] is True
    row, = rows()
    entry = next(e for e in cli.load_catalog().values() if e["command_path"] == COMMAND)
    assert UUID(row["event_id"]).version == 4
    assert row["command"] == "replenish store resolve"
    assert json.loads(row["skills"]) == entry["owner_skills"]
    assert len(entry["owner_skills"]) > 1
    assert row["ok"] == 1 and row["duration_ms"] >= 0 and row["uploaded_at"] is None
    assert re.fullmatch(r".*T\d\d:\d\d:\d\d\.\d{3}Z", row["occurred_at"])
    assert before <= datetime.fromisoformat(row["occurred_at"]) <= datetime.now(UTC)
    assert "private-store" not in str(row) and "--store-name" not in str(row)


@pytest.mark.parametrize("argv", [
    ["list"], ["describe", *COMMAND], ["help"], ["doctor"], ["datasets", "list"],
    ["cloud-status"], ["cloud-context"], [*COMMAND, "--help"], ["assets", "list"],
    ["replenish", "v2", "settings"], ["vietnam", "replenishment", "settings"], ["media", "synthetic-performer"],
])
def test_commands_without_attributed_runs_do_not_create_database(argv, tmp_path):
    cli.main(argv)
    assert not (tmp_path / "lxeskill.sqlite3").exists()


@pytest.mark.parametrize(("outcome", "code", "error"), [
    ("returned", cli.EXIT_BUSINESS, "business_failed"),
    ("raised", cli.EXIT_USAGE, "invalid_arguments"),
    ("unexpected", cli.EXIT_INTERNAL, "RuntimeError"),
])
def test_failed_commands_keep_their_result_and_record_failure(outcome, code, error, capsys, monkeypatch):
    def execute(*args, **kwargs):
        if outcome == "unexpected":
            raise RuntimeError("handler failed")
        return False, [], [], None

    monkeypatch.setattr(cli, "execute_module_json", execute)
    argv = [*COMMAND, "--unknown"] if outcome == "raised" else ARGV
    assert cli.main(argv) == code
    result = json.loads(capsys.readouterr().out)
    assert result["error"]["code"] == error
    assert [row["ok"] for row in rows()] == [0]


@pytest.mark.parametrize("server", ["", "not-a-url", "https://user:private@telemetry.test"])
def test_missing_or_invalid_url_keeps_rows(server, monkeypatch):
    monkeypatch.setenv("LXE_DATA_SERVER_URL", server)
    assert cli.main(ARGV) == 0
    assert rows()[0]["uploaded_at"] is None
    with connection_scope() as db:
        assert not db.execute("SELECT * FROM command_call_upload_state").fetchall()


def test_valid_ack_sends_only_call_fields_oldest_first(monkeypatch):
    assert cli.main(ARGV) == 0
    first, = rows()
    batches = []

    def reply(calls):
        batches.append(calls)
        return 200, {"accepted": 1, "duplicates": 1}

    http(monkeypatch, reply)
    assert cli.main(ARGV) == 0
    batch, = batches
    first_sent, second_sent = batch
    assert first_sent == {**{k: first[k] for k in ("command", "duration_ms", "occurred_at", "event_id")},
                          "ok": True, "skills": json.loads(first["skills"])}
    assert first_sent["ok"] is True
    assert second_sent["event_id"] != first_sent["event_id"]
    assert all(row["uploaded_at"] for row in rows())


@pytest.mark.parametrize("reply", [
    (200, {"accepted": 0, "duplicates": 0}), (200, {"accepted": True, "duplicates": 0}),
    (200, {"accepted": 2, "duplicates": -1}), (200, {"accepted": 1}), (200, b"invalid JSON"),
    (200, [1, 0]), (200, b'{"accepted":1,"duplicates":0}' + b' ' * 4096),
    (201, {"accepted": 1, "duplicates": 0}), (503, "offline"), OSError("network unavailable"),
])
def test_failed_upload_backs_off_then_resends_the_same_ids(reply, monkeypatch, capsys):
    batches = []

    def respond(calls):
        batches.append(calls)
        if len(batches) == 1:
            if isinstance(reply, Exception):
                raise reply
            return reply
        return 200, {"accepted": len(calls) - 1, "duplicates": 1}

    http(monkeypatch, respond)
    before = time.time()
    assert cli.main(ARGV) == 0
    first_output = capsys.readouterr().out
    assert json.loads(first_output)["ok"] is True
    with connection_scope() as db:
        retry_at, = db.execute("SELECT retry_after FROM command_call_upload_state").fetchone()
        assert before + 600 <= retry_at <= time.time() + 600
    assert cli.main(ARGV) == 0
    assert capsys.readouterr().out == first_output
    assert len(batches) == 1 and all(row["uploaded_at"] is None for row in rows())
    with connection_scope() as db:
        db.execute("UPDATE command_call_upload_state SET retry_after = 0")
    assert cli.main(ARGV) == 0
    assert capsys.readouterr().out == first_output
    assert len(batches) == 2 and len(batches[1]) == 3
    assert batches[1][0] == batches[0][0]
    assert all(row["uploaded_at"] for row in rows())


@pytest.mark.parametrize("argv", [ARGV, [*COMMAND, "--unknown"]])
def test_broken_database_preserves_exact_exit_and_stdout(tmp_path, monkeypatch, capsys, argv):
    code = cli.main(argv)
    normal_output = capsys.readouterr().out
    monkeypatch.setenv("LXE_SQLITE_DB_PATH", str(tmp_path))  # SQLite cannot open a directory.
    assert cli.main(argv) == code
    assert capsys.readouterr().out == normal_output


def test_upload_error_preserves_command_error_and_redacts_diagnostic(monkeypatch, capsys, caplog):
    argv = [*COMMAND, "--unknown"]
    code = cli.main(argv)
    expected_output = capsys.readouterr().out

    def offline(calls):
        raise OSError("connection refused: Bearer private-credential")

    http(monkeypatch, offline)
    caplog.set_level(logging.DEBUG, logger=usage.logger.name)
    assert cli.main(argv) == code == cli.EXIT_USAGE
    assert capsys.readouterr().out == expected_output
    assert "connection refused" in caplog.text and "private-credential" not in caplog.text
    assert all(not row["ok"] and row["uploaded_at"] is None for row in rows())


def seed_pending(count):
    with connection_scope() as db:
        db.executemany("""
            INSERT INTO command_calls(event_id, command, skills, ok, duration_ms, occurred_at)
            VALUES (?, 'historical', '["historical"]', 1, 12, '2001-01-01T00:00:00.000Z')
        """, [(f"seed-{i}",) for i in range(count)])


def test_retention_and_pending_cap():
    assert cli.main(ARGV) == 0
    seed_pending(5003)
    now = time.time()
    with connection_scope() as db:
        db.execute("UPDATE command_calls SET uploaded_at = ? WHERE event_id = 'seed-0'", (now - 31 * 86400,))
        db.execute("UPDATE command_calls SET uploaded_at = ? WHERE event_id = 'seed-1'", (now - 29 * 86400,))
    assert cli.main(ARGV) == 0
    records = rows()
    pending = [row for row in records if row["uploaded_at"] is None]
    assert len(pending) == 5000
    assert pending[0]["event_id"] == "seed-5"
    assert [row["event_id"] for row in records if row["uploaded_at"]] == ["seed-1"]


def test_limits_requests_and_batch_size(monkeypatch):
    assert cli.main(ARGV) == 0
    seed_pending(650)
    batches = []

    def reply(calls):
        batches.append(calls)
        return 200, {"accepted": len(calls), "duplicates": 0}

    http(monkeypatch, reply)
    assert cli.main(ARGV) == 0
    assert [len(batch) for batch in batches] == [200, 200, 200]
    assert [call["event_id"] for batch in batches for call in batch] == [f"seed-{i}" for i in range(600)]
    assert sum(row["uploaded_at"] is None for row in rows()) == 52


def test_later_failed_batch_keeps_prior_ack(monkeypatch):
    assert cli.main(ARGV) == 0
    seed_pending(205)

    def reply(calls):
        return 200, {"accepted": 200, "duplicates": 0}

    http(monkeypatch, reply)
    assert cli.main(ARGV) == 0
    records = rows()
    assert [row["event_id"] for row in records if row["uploaded_at"]] == [f"seed-{i}" for i in range(200)]
    assert sum(row["uploaded_at"] is None for row in records) == 7


def test_wall_clock_timeout_ignores_late_ack(monkeypatch):
    release, finished = Event(), Event()

    def stall(calls):
        release.wait(2)
        finished.set()
        return 200, {"accepted": len(calls), "duplicates": 0}

    http(monkeypatch, stall)
    monkeypatch.setattr(usage, "UPLOAD_SECONDS", 0.08)
    started = time.monotonic()
    try:
        assert cli.main(ARGV) == 0
        assert time.monotonic() - started < 1
    finally:
        release.set()
    assert finished.wait(1)
    assert rows()[0]["uploaded_at"] is None
    with connection_scope() as db:
        assert db.execute("SELECT retry_after FROM command_call_upload_state").fetchone()[0] > time.time()
