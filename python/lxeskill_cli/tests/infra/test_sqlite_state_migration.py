from __future__ import annotations

import hashlib
import os
import sqlite3
from contextlib import closing
from pathlib import Path

import pytest

from lxeskill.cli import main as lxeskill_main
from services.yacang.state import ExportState
from shared.db.sqlite.bootstrap import ensure_ziniao_schema
from shared.db.sqlite.engine import connect, database_path
from shared.db.sqlite.migrate import migrate_legacy_database


@pytest.fixture
def data_root(monkeypatch, tmp_path: Path) -> Path:
    root = tmp_path / "var"
    monkeypatch.setenv("LXE_DATA_ROOT", str(root))
    monkeypatch.delenv("LXE_SQLITE_DB_PATH", raising=False)
    return root


def _seed_database(path: Path, label: str, *, wal: bool = False, mixed: bool = False) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path)
    if wal:
        assert connection.execute("PRAGMA journal_mode=WAL").fetchone()[0].lower() == "wal"
    ensure_ziniao_schema(connection)
    connection.execute(
        "INSERT INTO ziniao_store_sessions (host_id, browser_oauth, browser_id, created_at, updated_at) "
        "VALUES (?, 'fixture', 1, '2026-10-08', '2026-10-08')", (label,),
    )
    connection.execute("CREATE TABLE yacang_submissions (key TEXT PRIMARY KEY, account TEXT NOT NULL, baseline TEXT NOT NULL, status TEXT NOT NULL)")
    connection.execute("INSERT INTO yacang_submissions VALUES ('task', ?, '[\"old\"]', 'submitting')", (label,))
    connection.execute("CREATE TABLE yacang_cooldown (account TEXT PRIMARY KEY, until REAL NOT NULL)")
    connection.execute("INSERT INTO yacang_cooldown VALUES (?, 1)", (label,))
    if mixed:
        connection.execute("CREATE TABLE agent_sessions (id TEXT PRIMARY KEY, content TEXT)")
        connection.execute("INSERT INTO agent_sessions VALUES ('bun', 'must not migrate')")
        connection.execute("CREATE TABLE unknown_state (value TEXT)")
    connection.commit()
    return connection


def _marker(path: Path) -> str:
    with sqlite3.connect(path) as connection:
        return connection.execute("SELECT host_id FROM ziniao_store_sessions").fetchone()[0]


def test_migrates_only_python_tables_from_mixed_legacy_database(data_root: Path) -> None:
    legacy = data_root / "db/local_agent.sqlite3"
    _seed_database(legacy, "legacy", mixed=True).close()
    before = hashlib.sha256(legacy.read_bytes()).hexdigest()
    bun = data_root / "db/agent.sqlite3"
    bun.write_bytes(b"bun-owned sentinel: do not open or migrate")

    target = data_root / "db/lxeskill/local_agent.sqlite3"
    assert migrate_legacy_database(target)
    with sqlite3.connect(target) as connection:
        assert connection.execute("PRAGMA integrity_check").fetchall() == [("ok",)]
        tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        assert tables == {"ziniao_store_sessions", "yacang_submissions", "yacang_cooldown"}
        assert connection.execute("SELECT account, baseline, status FROM yacang_submissions").fetchone() == ("legacy", '["old"]', "submitting")
        assert connection.execute("SELECT * FROM yacang_cooldown").fetchone() == ("legacy", 1)
    assert _marker(target) == "legacy"
    assert hashlib.sha256(legacy.read_bytes()).hexdigest() == before
    assert bun.read_bytes() == b"bun-owned sentinel: do not open or migrate"


def test_does_not_replace_existing_database(data_root: Path) -> None:
    legacy = data_root / "db/lxeskill.sqlite3"
    target = data_root / "db/lxeskill/lxeskill.sqlite3"
    _seed_database(legacy, "legacy").close()
    _seed_database(target, "canonical").close()
    assert not migrate_legacy_database(target)
    assert _marker(target) == "canonical"
    assert legacy.exists()


def test_migration_includes_committed_live_wal(data_root: Path) -> None:
    source = data_root / "db/lxeskill.sqlite3"
    connection = _seed_database(source, "live-wal", wal=True)
    try:
        assert Path(str(source) + "-wal").stat().st_size > 0
        target = data_root / "db/lxeskill/lxeskill.sqlite3"
        assert migrate_legacy_database(target)
        assert _marker(target) == "live-wal"
        assert source.exists()
        assert not (data_root / "db/agent.sqlite3").exists()
    finally:
        connection.close()


def test_default_path_and_custom_path_unchanged(monkeypatch, data_root: Path, tmp_path: Path) -> None:
    assert database_path() == data_root / "db/lxeskill/local_agent.sqlite3"
    custom = tmp_path / "custom.sqlite3"
    monkeypatch.setenv("LXE_SQLITE_DB_PATH", str(custom))
    assert database_path() == custom


@pytest.mark.parametrize("command", [["list"], ["describe", "yacang", "export", "run"], ["doctor"], ["--help"]])
def test_unrelated_cli_commands_do_not_migrate_legacy_state(monkeypatch, data_root: Path, capsys, command) -> None:
    (data_root / "db").mkdir(parents=True)
    (data_root / "db/local_agent.sqlite3").write_bytes(b"corrupt unrelated legacy database")
    monkeypatch.setenv("LXE_SKILLS_ROOT", str(Path(__file__).parents[4] / "skills"))
    assert lxeskill_main(command) == 0
    assert '"type":"result"' in capsys.readouterr().out
    assert not (data_root / "db/lxeskill").exists()


def test_custom_database_does_not_scan_corrupt_default_legacy(monkeypatch, data_root: Path, tmp_path: Path) -> None:
    (data_root / "db").mkdir(parents=True)
    (data_root / "db/local_agent.sqlite3").write_bytes(b"corrupt legacy")
    (data_root / "db/lxeskill.sqlite3").write_bytes(b"corrupt legacy")
    custom = tmp_path / "custom.sqlite3"
    monkeypatch.setenv("LXE_SQLITE_DB_PATH", str(custom))
    with closing(connect()) as connection:
        assert connection.execute("SELECT 1").fetchone()[0] == 1
    state = ExportState("fixture")
    state.begin("task", {"old"})
    assert state.pending("task") == {"old"}
    assert not (data_root / "db/lxeskill").exists()


def test_default_engine_migrates_only_its_database(data_root: Path) -> None:
    _seed_database(data_root / "db/local_agent.sqlite3", "standalone", mixed=True).close()
    (data_root / "db/lxeskill.sqlite3").write_bytes(b"corrupt unrelated legacy")
    with closing(connect()) as connection:
        assert connection.execute("SELECT host_id FROM ziniao_store_sessions").fetchone()[0] == "standalone"
    assert not (data_root / "db/lxeskill/lxeskill.sqlite3").exists()


def test_yacang_access_migrates_only_its_database(data_root: Path) -> None:
    _seed_database(data_root / "db/lxeskill.sqlite3", "desktop", mixed=True).close()
    (data_root / "db/local_agent.sqlite3").write_bytes(b"corrupt unrelated legacy")
    state = ExportState("desktop")
    assert not state.db.exists()
    assert state.pending("task") == {"old"}
    assert not (data_root / "db/lxeskill/local_agent.sqlite3").exists()


def test_desktop_injected_canonical_path_migrates_on_access(monkeypatch, data_root: Path) -> None:
    _seed_database(data_root / "db/lxeskill.sqlite3", "desktop").close()
    target = data_root / "db/lxeskill/lxeskill.sqlite3"
    monkeypatch.setenv("LXE_SQLITE_DB_PATH", str(target))
    with closing(connect()) as connection:
        assert connection.execute("SELECT host_id FROM ziniao_store_sessions").fetchone()[0] == "desktop"


def test_corrupt_required_database_fails_without_publishing_target(data_root: Path) -> None:
    (data_root / "db").mkdir(parents=True)
    source = data_root / "db/local_agent.sqlite3"
    source.write_bytes(b"corrupt required legacy")
    with pytest.raises(sqlite3.DatabaseError):
        connect()
    assert source.read_bytes() == b"corrupt required legacy"
    assert not (data_root / "db/lxeskill/local_agent.sqlite3").exists()
    assert not list((data_root / "db/lxeskill").glob(".*.migration-*"))


def test_legacy_with_only_bun_tables_is_not_copied(data_root: Path) -> None:
    source = data_root / "db/local_agent.sqlite3"
    source.parent.mkdir(parents=True)
    with sqlite3.connect(source) as connection:
        connection.execute("CREATE TABLE agent_sessions (id TEXT PRIMARY KEY)")
        connection.execute("INSERT INTO agent_sessions VALUES ('bun')")
    before = source.read_bytes()
    target = data_root / "db/lxeskill/local_agent.sqlite3"
    assert not migrate_legacy_database(target)
    assert not target.exists()
    assert source.read_bytes() == before
    assert not list(target.parent.glob(".*.migration-*"))


def test_concurrent_publication_does_not_overwrite_winner(monkeypatch, data_root: Path) -> None:
    source = data_root / "db/lxeskill.sqlite3"
    _seed_database(source, "legacy").close()
    target = data_root / "db/lxeskill/lxeskill.sqlite3"
    real_link = os.link

    def publish_after_other_process(temporary, destination):
        _seed_database(target, "other-process").close()
        real_link(temporary, destination)

    monkeypatch.setattr(os, "link", publish_after_other_process)
    assert not migrate_legacy_database(target)
    assert _marker(target) == "other-process"
    assert not list(target.parent.glob(".*.migration-*"))
