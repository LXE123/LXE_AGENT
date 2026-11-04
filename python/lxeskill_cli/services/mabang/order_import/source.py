from __future__ import annotations

from contextlib import contextmanager
from datetime import date
from decimal import Decimal, InvalidOperation
import math
from pathlib import Path
from typing import Any, Iterator, Mapping

from openpyxl import load_workbook
from openpyxl.utils import get_column_letter

from .workbook import OrderImportWorkbookError


def nearest_occurrence(
    month: int,
    day: int,
    today: date,
    *,
    country: str,
    label: str,
) -> date:
    possible = []
    for year in (today.year - 1, today.year, today.year + 1):
        try:
            possible.append(date(year, month, day))
        except ValueError:
            continue
    if not possible:
        raise OrderImportWorkbookError(f"{country}工作表运输日期表头无效: {label}")
    distance = min(abs((candidate - today).days) for candidate in possible)
    nearest = [candidate for candidate in possible if abs((candidate - today).days) == distance]
    if len(nearest) != 1:
        raise OrderImportWorkbookError(f"{country}工作表日期表头 {label} 跨年后与中国当天距离相同，无法确定年份")
    return nearest[0]


@contextmanager
def source_worksheets(
    input_path: Path,
    sheet_name: str,
    *,
    input_label: str = "备货清单",
) -> Iterator[tuple[Any, Any]]:
    if not input_path.is_file() or input_path.suffix.lower() != ".xlsx":
        raise OrderImportWorkbookError(f"{input_label}必须是存在的 .xlsx 文件")
    try:
        workbook = load_workbook(input_path, read_only=True, data_only=True)
    except Exception as exc:
        raise OrderImportWorkbookError(f"无法读取备货清单 XLSX: {type(exc).__name__}: {exc}") from exc
    formula_workbook = None
    try:
        if sheet_name not in workbook.sheetnames:
            raise OrderImportWorkbookError(f"备货清单缺少必需工作表: {sheet_name}")
        formula_workbook = load_workbook(input_path, read_only=True, data_only=False)
        yield workbook[sheet_name], formula_workbook[sheet_name]
    finally:
        if formula_workbook is not None:
            formula_workbook.close()
        workbook.close()


def require_sku_header(sheet: Any, sku_column: int, country: str) -> None:
    value = sheet.cell(1, sku_column).value
    if not isinstance(value, str) or value.strip().casefold() != "sku":
        coordinate = f"{get_column_letter(sku_column)}1"
        raise OrderImportWorkbookError(f"{country}工作表 {coordinate} 必须是 SKU 表头，当前为: {value!r}")


def parse_quantity(value: Any, *, coordinate: str, country: str) -> int | float | None:
    if value is None:
        return None
    if isinstance(value, bool):
        raise OrderImportWorkbookError(f"{country}工作表 {coordinate} 数量无效: 布尔值")
    try:
        numeric = Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError) as exc:
        raise OrderImportWorkbookError(f"{country}工作表 {coordinate} 数量无效: {value!r}") from exc
    if not numeric.is_finite() or numeric < 0:
        raise OrderImportWorkbookError(f"{country}工作表 {coordinate} 数量必须是有限非负数: {value!r}")
    if numeric == 0:
        return None
    if isinstance(value, int):
        return value
    try:
        number = float(value)
    except (ValueError, TypeError, OverflowError) as exc:
        raise OrderImportWorkbookError(f"{country}工作表 {coordinate} 数量超出 Excel 数值范围: {value!r}") from exc
    if not math.isfinite(number):
        raise OrderImportWorkbookError(f"{country}工作表 {coordinate} 数量超出 Excel 数值范围: {value!r}")
    return number


def read_sku_rows(
    sheet: Any,
    formula_sheet: Any,
    *,
    sku_column: int,
    quantity_columns: Mapping[str, int],
    country: str,
) -> list[tuple[int, str, dict[str, Any]]]:
    columns = (sku_column, *quantity_columns.values())
    first_column = min(columns)
    options = {
        "min_row": 2,
        "max_row": sheet.max_row,
        "min_col": first_column,
        "max_col": max(columns),
    }
    values_rows = sheet.iter_rows(**options, values_only=True)
    formula_rows = formula_sheet.iter_rows(**options)
    rows: list[tuple[int, str, dict[str, Any]]] = []
    sku_index = sku_column - first_column
    for row_number, (values, formula_cells) in enumerate(zip(values_rows, formula_rows, strict=True), start=2):
        sku_value = values[sku_index]
        sku_cell = formula_cells[sku_index]
        if sku_value is None and sku_cell.data_type == "f":
            raise OrderImportWorkbookError(
                f"{country}工作表 {sku_cell.coordinate} 公式没有缓存结果，请重新计算并保存备货清单"
            )
        if sku_value is None or (isinstance(sku_value, str) and not sku_value.strip()):
            continue
        if not isinstance(sku_value, str):
            raise OrderImportWorkbookError(f"{country}工作表 {sku_cell.coordinate} SKU 必须是文本: {sku_value!r}")

        quantities = {}
        for name, column in quantity_columns.items():
            index = column - first_column
            value = values[index]
            formula_cell = formula_cells[index]
            if value is None and formula_cell.data_type == "f":
                raise OrderImportWorkbookError(
                    f"{country}工作表 {formula_cell.coordinate} 公式没有缓存结果，请重新计算并保存备货清单"
                )
            quantities[name] = value
        rows.append((row_number, sku_value, quantities))
    if not rows:
        column = get_column_letter(sku_column)
        raise OrderImportWorkbookError(f"{country}工作表 {column} 列没有非空 SKU")
    return rows
