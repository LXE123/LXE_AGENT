"""Numeric values that can be written to Excel without changing their meaning."""

from __future__ import annotations

from decimal import Decimal, InvalidOperation
from math import isfinite


class WorkbookInputError(ValueError):
    """Current source data or explicit inputs cannot yield a complete workbook."""


def excel_number(value: object, sku: str, field: str, *, positive: bool = False) -> Decimal:
    """Validate a finite nonnegative decimal with exact Excel cell round trip."""
    if value is None or isinstance(value, str) and not value.strip():
        raise WorkbookInputError(f"SKU {sku} 的 {field} 缺失")
    if isinstance(value, bool):
        raise WorkbookInputError(f"SKU {sku} 的 {field} 不是有限非负数：布尔值")
    try:
        result = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError) as exc:
        raise WorkbookInputError(f"SKU {sku} 的 {field} 不是数字: {type(exc).__name__}: {exc}") from exc
    if not result.is_finite() or result < 0 or positive and result == 0:
        constraint = "有限正数" if positive else "有限非负数"
        raise WorkbookInputError(f"SKU {sku} 的 {field} 必须是{constraint}")
    if len(result.normalize().as_tuple().digits) > 15:
        raise WorkbookInputError(f"SKU {sku} 的 {field} 超出 Excel 精度（15 位有效数字）")
    try:
        as_float = float(result)
    except (OverflowError, ValueError) as exc:
        raise WorkbookInputError(f"SKU {sku} 的 {field} 超出 Excel 数值范围") from exc
    if not isfinite(as_float) or result != 0 and as_float == 0 or Decimal(str(as_float)) != result:
        raise WorkbookInputError(f"SKU {sku} 的 {field} 无法精确写入 Excel 数值单元格")
    return result


__all__ = ["WorkbookInputError", "excel_number"]
