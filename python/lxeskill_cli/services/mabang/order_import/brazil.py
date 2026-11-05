from __future__ import annotations

from datetime import date
from pathlib import Path
import re
from typing import Any

from openpyxl.utils.cell import column_index_from_string, get_column_letter

from .source import nearest_occurrence, read_sku_rows, require_sku_header, source_worksheets
from .workbook import OrderImportWorkbookError, generate_order_workbook as write_order_workbook


SOURCE_SHEET = "巴西"
SKU_COLUMN = 6  # F
SHIPPING_FIRST_COLUMN = 46  # AT
SHIPPING_LAST_COLUMN = 56  # BD
SEA_HEADER = re.compile(r"^(?P<month>[0-9]{1,2})/(?P<day>[0-9]{1,2})(?:[A-Z])?海运$", re.IGNORECASE)


def _shipping_candidates(sheet: Any, today: date) -> list[tuple[str, str, date]]:
    candidates: list[tuple[str, str, date]] = []
    for column in range(SHIPPING_FIRST_COLUMN, SHIPPING_LAST_COLUMN + 1):
        cell = sheet.cell(1, column)
        label = str(cell.value or "").strip()
        match = SEA_HEADER.fullmatch(label)
        if match is None:
            raise OrderImportWorkbookError(
                f"巴西工作表第1行 {get_column_letter(column)}1 海运日期表头缺失或格式无效: {label or '空白'}"
            )
        month, day = int(match.group("month")), int(match.group("day"))
        selected_date = nearest_occurrence(
            month, day, today, country="巴西", label=f"{cell.coordinate}: {label}", defer_year_tie=True,
        )
        candidates.append((cell.column_letter, label, selected_date))
    return candidates


def select_shipping_column(sheet: Any, today: date, override: str | None = None) -> tuple[str, str, date]:
    candidates = _shipping_candidates(sheet, today)
    minimum_distance = min(abs((candidate_date - today).days) for _, _, candidate_date in candidates)
    nearest = [candidate for candidate in candidates if abs((candidate[2] - today).days) == minimum_distance]
    if override is not None:
        column = str(override).strip().upper()
        selected = [candidate for candidate in nearest if candidate[0] == column]
        if not selected:
            options = ", ".join(f"{item[0]} ({item[1]})" for item in nearest)
            raise OrderImportWorkbookError(f"指定的海运列 {column} 不是最近日期列；当前最近日期列为: {options}")
        chosen = selected[0]
    elif len(nearest) != 1:
        options = ", ".join(f"{item[0]} ({item[1]})" for item in nearest)
        raise OrderImportWorkbookError(f"最近海运日期并列，请人工选择其中一列: {options}")
    else:
        chosen = nearest[0]
    nearest_occurrence(
        chosen[2].month, chosen[2].day, today, country="巴西", label=f"{chosen[0]}1: {chosen[1]}",
    )
    return chosen


def _source_rows(
    input_path: Path,
    today: date,
    shipping_column: str | None,
) -> tuple[list[tuple[str, Any]], str, str, date]:
    with source_worksheets(input_path, SOURCE_SHEET) as (sheet, formula_sheet):
        require_sku_header(sheet, SKU_COLUMN, "巴西")
        selected_column, header, selected_date = select_shipping_column(sheet, today, shipping_column)
        quantity_column_number = column_index_from_string(selected_column)
        source_rows = read_sku_rows(
            sheet,
            formula_sheet,
            sku_column=SKU_COLUMN,
            quantity_columns={"quantity": quantity_column_number},
            country="巴西",
        )
        rows = [(sku, quantities["quantity"]) for sku, quantities in source_rows]
    return rows, selected_column, header, selected_date


def generate_order_workbook(
    input_xlsx: str | Path,
    output_xlsx: str | Path,
    *,
    today: date,
    shipping_column: str | None = None,
    template_path: str | Path,
) -> dict[str, Any]:
    input_path = Path(input_xlsx)
    rows, selected_column, selected_header, selected_date = _source_rows(input_path, today, shipping_column)
    order_id = f"BR{today:%y%m%d}-H"
    result = write_order_workbook(rows, output_xlsx, order_id=order_id, template_path=template_path)
    return {
        **result,
        "shipping_column": selected_column,
        "shipping_header": selected_header,
        "shipping_date": selected_date.isoformat(),
    }
