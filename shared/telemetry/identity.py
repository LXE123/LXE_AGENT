from __future__ import annotations

import json
import os
import socket
from datetime import datetime, timezone
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Any
from uuid import uuid4

from shared.db.sqlite.engine import database_path
from shared.env_config import env_text
from shared.logging import logger


def machine_identity_path() -> Path:
    configured = env_text("TELEMETRY_MACHINE_ID_PATH", "")
    if configured:
        return Path(configured).expanduser()
    return database_path().parent / "machine_identity.json"


def _read_machine_id(path: Path) -> str:
    if not path.is_file():
        return ""
    try:
        payload = json.loads(path.read_text(encoding="utf-8") or "{}")
    except Exception as exc:
        logger.warning("[Telemetry] machine identity unreadable: path=%s error=%s", path, exc)
        return ""
    if not isinstance(payload, dict):
        return ""
    return str(payload.get("machine_id") or "").strip()


def _write_identity(path: Path, *, machine_id: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload: dict[str, Any] = {
        "machine_id": machine_id,
        "hostname_at_creation": socket.gethostname(),
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    encoded = json.dumps(payload, ensure_ascii=False, indent=2)
    with NamedTemporaryFile(
        "w",
        encoding="utf-8",
        dir=str(path.parent),
        delete=False,
        prefix=f".{path.name}.",
        suffix=".tmp",
    ) as handle:
        handle.write(encoded)
        handle.write("\n")
        temp_path = Path(handle.name)
    try:
        os.chmod(temp_path, 0o600)
    except Exception:
        pass
    temp_path.replace(path)
    try:
        os.chmod(path, 0o600)
    except Exception:
        pass


def load_or_create_machine_id(path: Path | None = None) -> str:
    target = Path(path) if path is not None else machine_identity_path()
    existing = _read_machine_id(target)
    if existing:
        return existing
    machine_id = uuid4().hex
    _write_identity(target, machine_id=machine_id)
    logger.info("[Telemetry] created machine identity: path=%s", target)
    return machine_id


__all__ = ["load_or_create_machine_id", "machine_identity_path"]
