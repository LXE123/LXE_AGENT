from __future__ import annotations

from pathlib import Path

from shared.datasets import dataset_dir


def resolve_wms_consignment_dir(*, create: bool = False) -> Path:
    path = dataset_dir("fba_wms_consignment")
    if create:
        path.mkdir(parents=True, exist_ok=True)
    return path
