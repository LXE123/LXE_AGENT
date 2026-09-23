from __future__ import annotations

import re
from datetime import date
from enum import StrEnum

from services.yacang.warehouses import WAREHOUSES, select_warehouses, warehouse_display_name


class YacangExportKind(StrEnum):
    INVENTORY_SALES = "inventory-sales"
    # Compatibility-only command kinds. Formal plans use INVENTORY_SALES.
    SALES_MONTHLY = "sales-monthly"
    SALES_90D = "sales-90d"
    INVENTORY_CURRENT_SNAPSHOT = "inventory-current-snapshot"
    # Compatibility alias for existing internal callers. Its value stays canonical.
    INVENTORY_MONTH_END = INVENTORY_CURRENT_SNAPSHOT
    INBOUND_LISTING_TIME = "inbound-listing-time"


WAREHOUSE_EXPORTS = {
    YacangExportKind.INVENTORY_SALES,
    YacangExportKind.SALES_MONTHLY,
    YacangExportKind.SALES_90D,
    YacangExportKind.INVENTORY_CURRENT_SNAPSHOT,
}
SALES_MONTHLY_WINDOWS = (7, 15, 30)
_WINDOWS_RESERVED_NAMES = {
    "CON", "PRN", "AUX", "NUL",
    *(f"COM{index}" for index in range(1, 10)),
    *(f"LPT{index}" for index in range(1, 10)),
}
_INVALID_FILENAME_CHARACTERS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def business_name(kind: YacangExportKind, *, range_days: int | None = None) -> str:
    if kind in {
        YacangExportKind.INVENTORY_SALES,
        YacangExportKind.SALES_MONTHLY,
        YacangExportKind.SALES_90D,
    }:
        if range_days is not None:
            raise ValueError("inventory-sales 固定输出完整库存动销字段，不接受 range_days")
        return "雅仓系统-库存动销"
    if range_days is not None:
        raise ValueError(f"{kind.value} 不接受 range_days")
    return {
        YacangExportKind.INVENTORY_CURRENT_SNAPSHOT: "雅仓系统-库存列表",
        YacangExportKind.INBOUND_LISTING_TIME: "雅仓系统-产品-仓库产品",
    }[kind]


def safe_windows_component(value: str) -> str:
    raw = str(value or "")
    if ".." in raw:
        raise ValueError("文件名组成部分不得包含 ..")
    component = _INVALID_FILENAME_CHARACTERS.sub("", raw).rstrip(" .")
    if not component:
        raise ValueError("文件名组成部分不能为空")
    if component.upper() in _WINDOWS_RESERVED_NAMES:
        component = f"_{component}"
    return component


def export_filename(
    kind: YacangExportKind,
    *,
    file_date: str,
    warehouse_code: str | None = None,
    range_days: int | None = None,
) -> str:
    normalized_date = date.fromisoformat(str(file_date or "").strip()).isoformat()
    needs_warehouse = kind in WAREHOUSE_EXPORTS
    warehouse = str(warehouse_code or "").strip()
    if needs_warehouse and not warehouse:
        raise ValueError(f"{kind.value} 必须指定 warehouse_code")
    if not needs_warehouse and warehouse:
        raise ValueError(f"{kind.value} 不接受 warehouse_code")
    warehouse_name = warehouse_display_name(warehouse) if warehouse else ""
    parts = [safe_windows_component(business_name(kind, range_days=range_days))]
    if warehouse_name:
        parts.append(safe_windows_component(warehouse_name))
    parts.append(normalized_date)
    return "_".join(parts) + ".xlsx"


def inventory_sales_filename(warehouse_codes: list[str] | tuple[str, ...], *, file_date: str) -> str:
    selected = select_warehouses(warehouse_codes)
    if len(selected) == 1:
        return export_filename(
            YacangExportKind.INVENTORY_SALES,
            warehouse_code=selected[0].code,
            file_date=file_date,
        )
    scope = "四仓" if len(selected) == len(WAREHOUSES) else "-".join(
        warehouse.display_name for warehouse in selected
    )
    normalized_date = date.fromisoformat(str(file_date or "").strip()).isoformat()
    return "_".join(
        [
            safe_windows_component(business_name(YacangExportKind.INVENTORY_SALES)),
            safe_windows_component(scope),
            normalized_date,
        ]
    ) + ".xlsx"


__all__ = [
    "SALES_MONTHLY_WINDOWS",
    "WAREHOUSE_EXPORTS",
    "YacangExportKind",
    "business_name",
    "export_filename",
    "inventory_sales_filename",
    "safe_windows_component",
]
