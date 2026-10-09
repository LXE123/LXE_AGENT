"""Validate and relocate Python-owned state in an offline data-directory copy."""
from __future__ import annotations

import argparse
import sqlite3
from pathlib import Path


def relocate_data(copy: Path, source: Path, target: Path) -> None:
    def relocate(value: str) -> str:
        try:
            return str(target / Path(value).relative_to(source))
        except ValueError:
            return value

    for relative in (Path("db/lxeskill/lxeskill.sqlite3"), Path("db/lxeskill.sqlite3")):
        path = copy / relative
        if not path.exists():
            continue
        conn = sqlite3.connect(path)
        try:
            result = conn.execute("PRAGMA integrity_check").fetchall()
            if result != [("ok",)]:
                raise RuntimeError(f"{relative.as_posix()} integrity_check: {result!r}")
            columns = {row[1] for row in conn.execute("PRAGMA table_info(ziniao_store_sessions)")}
            for column in ("download_path", "browser_path"):
                if column in columns:
                    for row_id, value in conn.execute(f"SELECT rowid, {column} FROM ziniao_store_sessions").fetchall():
                        updated = relocate(value)
                        if value != updated:
                            conn.execute(f"UPDATE ziniao_store_sessions SET {column}=? WHERE rowid=?", (updated, row_id))
            conn.commit()
            conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        finally:
            conn.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    for name in ("copy", "source", "target"):
        parser.add_argument(f"--{name}", type=Path, required=True)
    args = parser.parse_args()
    roots = (args.copy, args.source, args.target)
    if not all(path.is_absolute() for path in roots) or len({path.resolve() for path in roots}) != 3:
        parser.error("copy, source and target must be distinct absolute paths")
    relocate_data(*roots)
