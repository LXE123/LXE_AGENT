from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class ZhihuiTmsProductExportIntent:
    kind: str = "philippines_product_full_export"
    warehouse: str = "PH"
    historical_metrics_available: bool = False


def normalize_product_export_intent(arguments: dict[str, Any]) -> ZhihuiTmsProductExportIntent:
    """Validate the public structured contract before any client construction."""
    if not isinstance(arguments, dict):
        raise ValueError("arguments 必须是对象")
    unknown = set(arguments) - {"platform", "warehouse", "intent"}
    if unknown:
        raise ValueError(f"不支持的参数: {', '.join(sorted(unknown))}")
    if arguments.get("platform") != "zhihui_tms":
        raise ValueError("platform 必须是 zhihui_tms")
    if arguments.get("warehouse") != "PH":
        raise ValueError("warehouse 必须是 PH")
    if arguments.get("intent") != "product_export":
        raise ValueError("intent 必须是 product_export")
    return ZhihuiTmsProductExportIntent()


__all__ = ["ZhihuiTmsProductExportIntent", "normalize_product_export_intent"]
