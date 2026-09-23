"""Fixed business contracts for Brazil overseas warehouse exports."""

from dataclasses import dataclass
from enum import StrEnum

from shared.datasets import dataset_dir


BRAZIL_OVERSEAS_WAREHOUSE_ID = "1072376"
BRAZIL_OVERSEAS_WAREHOUSE_LABEL = "巴西海外仓"
INVENTORY_SALES_SOURCE_NOTE = "平台原始库存文件仅含7/28/42天累计销量"
DEFAULT_OUTPUT_DIR = dataset_dir("replenish_brazil_overseas")


class BrazilExportKind(StrEnum):
    INVENTORY_SALES_SNAPSHOT = "inventory_sales_snapshot"
    ALLOCATION_BOTH = "allocation_both"
    ALLOCATION_SIGNED_BEFORE_3M = "allocation_signed_before_3m"
    ALLOCATION_PENDING_DEFAULT_3M = "allocation_pending_default_3m"


@dataclass(frozen=True)
class BrazilExportPlan:
    kind: BrazilExportKind
    warehouse_id: str = BRAZIL_OVERSEAS_WAREHOUSE_ID
    warehouse_label: str = BRAZIL_OVERSEAS_WAREHOUSE_LABEL
    source_data_note: str = INVENTORY_SALES_SOURCE_NOTE


__all__ = [
    "BRAZIL_OVERSEAS_WAREHOUSE_ID",
    "BRAZIL_OVERSEAS_WAREHOUSE_LABEL",
    "DEFAULT_OUTPUT_DIR",
    "INVENTORY_SALES_SOURCE_NOTE",
    "BrazilExportKind",
    "BrazilExportPlan",
]
