import sqlite3
from pathlib import Path

import pytest

from shared.db.relocate_data import relocate_data


def test_only_python_owned_database_is_opened(tmp_path: Path):
    copy, source, target = (tmp_path / part for part in ("copy", "old", "new"))
    (copy / "db").mkdir(parents=True)
    agent = copy / "db" / "agent.sqlite3"
    agent.write_bytes(b"must never open the agent database")
    db = sqlite3.connect(copy / "db" / "lxeskill.sqlite3")
    db.execute("CREATE TABLE ziniao_store_sessions (download_path TEXT, browser_path TEXT)")
    db.execute("INSERT INTO ziniao_store_sessions VALUES (?,?)", (str(source / "downloads"), str(tmp_path / "external")))
    db.commit()
    db.close()
    relocate_data(copy, source, target)
    with sqlite3.connect(copy / "db" / "lxeskill.sqlite3") as db:
        assert db.execute("SELECT * FROM ziniao_store_sessions").fetchone() == (str(target / "downloads"), str(tmp_path / "external"))
    assert agent.read_bytes() == b"must never open the agent database"


def test_corrupt_python_database_is_not_silently_recreated(tmp_path: Path):
    (tmp_path / "db").mkdir()
    (tmp_path / "db" / "lxeskill.sqlite3").write_bytes(b"broken database")
    with pytest.raises(sqlite3.DatabaseError):
        relocate_data(tmp_path, tmp_path / "old", tmp_path / "new")


def test_relocates_python_scoped_database_path(tmp_path: Path):
    copy, source, target = (tmp_path / part for part in ("copy", "old", "new"))
    path = copy / "db" / "lxeskill" / "lxeskill.sqlite3"
    path.parent.mkdir(parents=True)
    with sqlite3.connect(path) as db:
        db.execute("CREATE TABLE ziniao_store_sessions (download_path TEXT, browser_path TEXT)")
        db.execute("INSERT INTO ziniao_store_sessions VALUES (?,?)", (str(source / "downloads"), str(source / "browser")))
    relocate_data(copy, source, target)
    with sqlite3.connect(path) as db:
        assert db.execute("SELECT * FROM ziniao_store_sessions").fetchone() == (
            str(target / "downloads"),
            str(target / "browser"),
        )
