from __future__ import annotations

from shared.env_config import env_flag

FBA_LOGISTICS_ENABLE_WMS_EXPORT = env_flag("FBA_LOGISTICS_ENABLE_WMS_EXPORT", True)
FBA_LOGISTICS_WMS_EXPORT_STRICT = env_flag("FBA_LOGISTICS_WMS_EXPORT_STRICT", False)


__all__ = [
    "FBA_LOGISTICS_ENABLE_WMS_EXPORT",
    "FBA_LOGISTICS_WMS_EXPORT_STRICT",
]
