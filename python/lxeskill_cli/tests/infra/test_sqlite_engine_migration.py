from __future__ import annotations

import sqlite3

from shared.db.sqlite.engine import connect, database_path


def test_default_name_migrates_legacy_python_state_with_wal(tmp_path, monkeypatch):
    monkeypatch.setenv("LXE_DATA_ROOT", str(tmp_path))
    monkeypatch.delenv("LXE_SQLITE_DB_PATH", raising=False)
    legacy = tmp_path / "db" / "local_agent.sqlite3"
    legacy.parent.mkdir(parents=True)
    with sqlite3.connect(legacy) as source:
        source.execute("PRAGMA journal_mode = WAL")
        source.execute("CREATE TABLE yacang_export_submissions (submission_key TEXT PRIMARY KEY, state TEXT NOT NULL)")
        source.execute("INSERT INTO yacang_export_submissions VALUES ('preserved', 'done')")
        source.execute("CREATE TABLE ziniao_store_sessions (host_id TEXT PRIMARY KEY)")
        source.execute("INSERT INTO ziniao_store_sessions VALUES ('browser-host')")
        source.execute("CREATE TABLE yacang_provider_cooldowns (provider TEXT PRIMARY KEY, reason TEXT NOT NULL)")
        source.execute("INSERT INTO yacang_provider_cooldowns VALUES ('yacang', 'rate-limit')")
        source.execute("CREATE TABLE yacang_request_gate (provider TEXT PRIMARY KEY, owner TEXT NOT NULL)")
        source.execute("INSERT INTO yacang_request_gate VALUES ('yacang', 'fixture-owner')")
        source.execute("CREATE TABLE agent_sessions (session_id TEXT PRIMARY KEY)")
        source.execute("INSERT INTO agent_sessions VALUES ('bun-owned')")
        source.commit()
        assert database_path() == tmp_path / "db" / "lxeskill.sqlite3"
        with connect() as migrated:
            assert migrated.execute("SELECT state FROM yacang_export_submissions WHERE submission_key = 'preserved'").fetchone()[0] == "done"
            assert migrated.execute("SELECT host_id FROM ziniao_store_sessions").fetchone()[0] == "browser-host"
            assert migrated.execute("SELECT reason FROM yacang_provider_cooldowns").fetchone()[0] == "rate-limit"
            assert migrated.execute("SELECT owner FROM yacang_request_gate").fetchone()[0] == "fixture-owner"
            assert migrated.execute("SELECT name FROM sqlite_master WHERE name = 'agent_sessions'").fetchone() is None
    assert legacy.exists()
    assert database_path().exists()


def test_explicit_python_database_path_is_not_migrated(tmp_path, monkeypatch):
    configured = tmp_path / "custom.sqlite3"
    monkeypatch.setenv("LXE_DATA_ROOT", str(tmp_path))
    monkeypatch.setenv("LXE_SQLITE_DB_PATH", str(configured))
    with connect() as connection:
        connection.execute("CREATE TABLE python_state (value INTEGER)")
    assert database_path() == configured
    assert configured.exists()
    assert not (tmp_path / "db" / "lxeskill.sqlite3").exists()
