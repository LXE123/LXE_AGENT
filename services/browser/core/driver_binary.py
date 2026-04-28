from __future__ import annotations

from pathlib import Path

from shared.config import config


def driver_folder_path() -> str:
    return str(Path(str(getattr(config, "ZINIAO_WEBDRIVER_PATH", "") or "").strip()).expanduser())


__all__ = ["driver_folder_path"]
