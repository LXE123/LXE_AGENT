import sqlite3
from contextlib import closing

import pytest

from services.yacang.state import ExportState
from shared.db.sqlite import store_sessions


@pytest.mark.parametrize("override", [None, "custom/business.sqlite3"])
def test_ziniao_and_yacang_use_one_business_database(tmp_path, monkeypatch, override):
    monkeypatch.setenv("LXE_DATA_ROOT", str(tmp_path))
    expected = tmp_path / (override or "db/lxeskill.sqlite3")
    if override is None:
        monkeypatch.delenv("LXE_SQLITE_DB_PATH", raising=False)
    else:
        monkeypatch.setenv("LXE_SQLITE_DB_PATH", str(expected))

    assert store_sessions.list_store_sessions(host_id="host") == []
    ExportState("account").cooldown()

    assert list(tmp_path.rglob("*.sqlite3")) == [expected]
    with closing(sqlite3.connect(expected)) as db:
        tables = {name for (name,) in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert {"ziniao_store_sessions", "yacang_cooldown", "yacang_submissions"} <= tables
