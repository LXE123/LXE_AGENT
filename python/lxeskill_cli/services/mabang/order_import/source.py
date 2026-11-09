from __future__ import annotations

from contextlib import closing, contextmanager
from datetime import date
from decimal import Decimal, InvalidOperation
import math
from pathlib import Path
from typing import Any, Iterator, Mapping

from openpyxl import load_workbook
from openpyxl.compat import safe_string
from openpyxl.utils import coordinate_to_tuple, get_column_letter
from openpyxl.xml.constants import SHEET_MAIN_NS
from openpyxl.xml.functions import iterparse

from .workbook import OrderImportWorkbookError


def nearest_occurrence(
    month: int,
    day: int,
    today: date,
    *,
    country: str,
    label: str,
    defer_year_tie: bool = False,
) -> date:
    """Defer a year tie only while scanning; recheck the selected column strictly."""
    possible = []
    # Adjacent leap days can be eight years apart around a non-leap century.
    for year in range(max(1, today.year - 4), min(9999, today.year + 4) + 1):
        try:
            possible.append(date(year, month, day))
        except ValueError:
            continue
    if not possible:
        raise OrderImportWorkbookError(f"{country}工作表运输日期表头无效: {label}")
    distance = min(abs((candidate - today).days) for candidate in possible)
    nearest = [candidate for candidate in possible if abs((candidate - today).days) == distance]
    if len(nearest) != 1 and not defer_year_tie:
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
        sheet, formula_sheet = workbook[sheet_name], formula_workbook[sheet_name]
        sheet.reset_dimensions()
        formula_sheet.reset_dimensions()
        yield sheet, formula_sheet
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
    try:
        number = float(value)
    except (ValueError, TypeError, OverflowError) as exc:
        raise OrderImportWorkbookError(f"{country}工作表 {coordinate} 数量超出 Excel 数值范围: {value!r}") from exc
    if not math.isfinite(number):
        raise OrderImportWorkbookError(f"{country}工作表 {coordinate} 数量超出 Excel 数值范围: {value!r}")
    if Decimal(safe_string(number)) != numeric:
        raise OrderImportWorkbookError(f"{country}工作表 {coordinate} 数量超出 Excel 可保存的精度或范围: {value!r}")
    return value if isinstance(value, int) else number


def _empty_formula_caches(sheet: Any) -> set[str]:
    """Distinguish an explicit empty string cache from a missing <v> element."""
    namespace = f"{{{SHEET_MAIN_NS}}}"
    cached = set()
    row_number = 0
    # openpyxl exposes both cases as None, so inspect the original worksheet XML.
    with sheet._get_source() as source:
        for _, element in iterparse(source):
            if element.tag != f"{namespace}row":
                continue
            row_number = int(element.get("r", row_number + 1))
            column = 0
            for cell in element:
                column += 1
                cell_row = row_number
                if cell.get("r"):
                    cell_row, column = coordinate_to_tuple(cell.get("r"))
                value = cell.find(f"{namespace}v")
                if (
                    cell.get("t") == "str" and cell.find(f"{namespace}f") is not None
                    and value is not None and not value.text
                ):
                    cached.add(f"{get_column_letter(column)}{cell_row}")
            element.clear()
    return cached


def read_sku_rows(
    sheet: Any,
    formula_sheet: Any,
    *,
    sku_column: int,
    quantity_columns: Mapping[str, int],
    country: str,
) -> list[tuple[str, dict[str, int | float | None]]]:
    columns = (sku_column, *quantity_columns.values())
    first_column = min(columns)
    options = {
        "min_row": 2,
        "min_col": first_column,
        "max_col": max(columns),
    }
    values_rows = sheet.iter_rows(**options)
    formula_rows = formula_sheet.iter_rows(**options)
    empty_formula_caches = None

    def read_value(cell: Any, formula_cell: Any) -> Any:
        nonlocal empty_formula_caches
        if cell.data_type == "e":
            raise OrderImportWorkbookError(f"{country}工作表 {formula_cell.coordinate} 单元格错误: {cell.value}")
        if cell.value is None and formula_cell.data_type == "f":
            if empty_formula_caches is None:
                empty_formula_caches = _empty_formula_caches(formula_sheet)
            if formula_cell.coordinate not in empty_formula_caches:
                raise OrderImportWorkbookError(
                    f"{country}工作表 {formula_cell.coordinate} 公式没有缓存结果，请重新计算并保存备货清单"
                )
        return cell.value

    rows: list[tuple[str, dict[str, int | float | None]]] = []
    sku_index = sku_column - first_column
    with closing(values_rows), closing(formula_rows):
        for row_number, (cells, formula_cells) in enumerate(zip(values_rows, formula_rows, strict=True), start=2):
            sku_cell = formula_cells[sku_index]
            sku_value = read_value(cells[sku_index], sku_cell)
            if sku_value is None or (isinstance(sku_value, str) and not sku_value.strip()):
                continue
            if not isinstance(sku_value, str):
                raise OrderImportWorkbookError(f"{country}工作表 {sku_cell.coordinate} SKU 必须是文本: {sku_value!r}")

            quantities = {
                name: parse_quantity(
                    read_value(cells[column - first_column], formula_cells[column - first_column]),
                    coordinate=f"{get_column_letter(column)}{row_number}", country=country,
                )
                for name, column in quantity_columns.items()
            }
            rows.append((sku_value, quantities))
    if not rows:
        column = get_column_letter(sku_column)
        raise OrderImportWorkbookError(f"{country}工作表 {column} 列没有非空 SKU")
    return rows
