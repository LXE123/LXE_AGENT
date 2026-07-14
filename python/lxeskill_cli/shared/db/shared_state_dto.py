from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any, Optional


@dataclass
class ZiniaoStoreSessionState:
    host_id: str
    browser_oauth: str
    browser_id: int
    browser_name: str
    debugging_port: int
    download_path: str
    browser_path: str
    core_type: Any
    core_version: str
    created_at: Optional[datetime]
    updated_at: Optional[datetime]


__all__ = [
    "ZiniaoStoreSessionState",
]
