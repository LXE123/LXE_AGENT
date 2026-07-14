from __future__ import annotations

from pathlib import Path

from services.browser.store import ziniao_config as ziniao_settings


def driver_folder_path() -> str:
    return str(Path(str(ziniao_settings.ZINIAO_WEBDRIVER_PATH or "").strip()).expanduser())


__all__ = ["driver_folder_path"]
