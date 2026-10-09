"""Migrate only Python-owned tables when their canonical database is first used."""
from __future__ import annotations

import os
import sqlite3
import tempfile
from pathlib import Path

from shared.filesystem import display_path, filesystem_path
from shared.repository import state_root


_LEGACY_DATABASES = (
    (Path("db/lxeskill.sqlite3"), Path("db/lxeskill/lxeskill.sqlite3")),
    (Path("db/local_agent.sqlite3"), Path("db/lxeskill/local_agent.sqlite3")),
)
_PYTHON_TABLES = ("ziniao_store_sessions", "yacang_submissions", "yacang_cooldown")


def _copy_and_validate(source: Path, target: Path) -> bool:
    target.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{target.name}.migration-", suffix=".sqlite3", dir=target.parent
    )
    os.close(descriptor)
    temporary = Path(temporary_name)
    try:
        source_uri = source.resolve().as_uri() + "?mode=ro"
        source_db = sqlite3.connect(source_uri, uri=True)
        target_db = sqlite3.connect(temporary)
        try:
            # One read transaction includes committed WAL data, but never reads
            # Bun/unknown table contents or copies a whole legacy database.
            source_db.execute("BEGIN")
            copied = False
            for table in _PYTHON_TABLES:
                schema = source_db.execute(
                    "SELECT sql FROM sqlite_master WHERE type='table' AND name=?", (table,)
                ).fetchone()
                if schema is None:
                    continue
                target_db.execute(schema[0])
                rows = source_db.execute(f'SELECT * FROM "{table}"')
                placeholders = ",".join("?" for _ in rows.description)
                target_db.executemany(f'INSERT INTO "{table}" VALUES ({placeholders})', rows)
                copied = True
            if not copied:
                return False
            target_db.commit()
            result = target_db.execute("PRAGMA integrity_check").fetchall()
            if result != [("ok",)]:
                raise RuntimeError(f"{source.name} integrity_check: {result!r}")
        finally:
            target_db.close()
            source_db.close()
        try:
            os.chmod(temporary, 0o600)
        except OSError:
            # Windows ACLs provide the data-root boundary; chmod is advisory there.
            pass
        try:
            # A same-directory hard link atomically installs without replacing
            # a target another first-run process may have just created.
            os.link(temporary, target)
            return True
        except FileExistsError:
            return False
    finally:
        temporary.unlink(missing_ok=True)


def migrate_legacy_database(path: Path) -> bool:
    """Migrate the requested default DB only; custom DB paths are untouched."""
    root = state_root()
    requested = display_path(path).expanduser().resolve()
    for old_relative, new_relative in _LEGACY_DATABASES:
        if requested != root / new_relative:
            continue
        source = filesystem_path(root / old_relative)
        target = filesystem_path(requested)
        if not source.is_file() or target.exists():
            return False
        return _copy_and_validate(source, target)
    return False


__all__ = ["migrate_legacy_database"]
