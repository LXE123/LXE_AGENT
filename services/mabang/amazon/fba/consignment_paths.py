from __future__ import annotations

from pathlib import Path

from shared.workspace import artifact_path


def resolve_wms_consignment_dir(*, create: bool = False) -> Path:
    path = artifact_path("mabang_wms_consignment")
    if create:
        path.mkdir(parents=True, exist_ok=True)
    return path
