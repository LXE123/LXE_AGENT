"""Business-visible filenames for Brazil overseas warehouse source workbooks."""

from datetime import datetime
from zoneinfo import ZoneInfo

from .contracts import BrazilExportKind


BEIJING_TZ = ZoneInfo("Asia/Shanghai")
_FILENAME_PREFIXES = {
    BrazilExportKind.INVENTORY_SALES_SNAPSHOT: "马帮系统-库存-巴西海外仓",
    BrazilExportKind.ALLOCATION_SIGNED_BEFORE_3M: "马帮系统-已签收-巴西海外仓",
    BrazilExportKind.ALLOCATION_PENDING_DEFAULT_3M: "马帮系统-3个月待签收-巴西海外仓",
}


def output_filename(kind: BrazilExportKind, *, executed_at: datetime, extension: str = "xlsx") -> str:
    """Return the approved source-workbook name in Beijing local time."""
    if executed_at.tzinfo is None:
        raise ValueError("executed_at must be timezone-aware")
    normalized_extension = extension.lstrip(".")
    if not normalized_extension or "/" in normalized_extension or "\\" in normalized_extension:
        raise ValueError("extension must be a simple file extension")
    return f"{_FILENAME_PREFIXES[kind]}-{executed_at.astimezone(BEIJING_TZ):%Y-%m-%d_%H%M}.{normalized_extension}"


__all__ = ["BEIJING_TZ", "output_filename"]
