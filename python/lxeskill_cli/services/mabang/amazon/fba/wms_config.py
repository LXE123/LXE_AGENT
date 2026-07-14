from __future__ import annotations

from shared.env_config import env_int

FBA_LOGISTICS_WMS_EXPORT_RETRY = env_int("FBA_LOGISTICS_WMS_EXPORT_RETRY", 1, minimum=0)


__all__ = ["FBA_LOGISTICS_WMS_EXPORT_RETRY"]
