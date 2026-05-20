from __future__ import annotations

from pathlib import Path

WMS_CONSIGNMENT_DIR = Path("artifacts") / "mabang_wms_consignment"


def workspace_root() -> Path:
    return Path(__file__).resolve().parents[4]


def resolve_wms_consignment_dir(*, create: bool = False) -> Path:
    path = workspace_root() / WMS_CONSIGNMENT_DIR
    if create:
        path.mkdir(parents=True, exist_ok=True)
    return path
