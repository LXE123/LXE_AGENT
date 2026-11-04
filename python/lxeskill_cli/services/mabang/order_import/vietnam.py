from __future__ import annotations

from datetime import date
from pathlib import Path
import re
from typing import Any

from openpyxl.utils import get_column_letter

from .source import nearest_occurrence, parse_quantity, read_sku_rows, require_sku_header, source_worksheets
from .workbook import OrderImportWorkbookError, generate_order_workbook as write_order_workbook


SOURCE_SHEET = "越南备货清单"
SKU_COLUMN = 5  # E
HEADER = re.compile(r"^(?P<month>[0-9]{1,2})/(?P<day>[0-9]{1,2})(?P<mode>陆运|海运)$")
MODE_SUFFIX = {"陆运": "L", "海运": "H"}


def shipping_candidates(sheet: Any, today: date) -> list[tuple[int, str, date, str]]:
    candidates: list[tuple[int, str, date, str]] = []
    for cell in sheet[1]:
        label = str(cell.value or "").strip()
        if not label:
            continue
        match = HEADER.fullmatch(label)
        if match is None:
            if "/" in label and ("陆运" in label or "海运" in label):
                raise OrderImportWorkbookError(
                    f"越南工作表第1行 {cell.coordinate} 运输日期字段格式无效: {label}"
                )
            continue
        mode = match.group("mode")
        selected_date = nearest_occurrence(
            int(match.group("month")), int(match.group("day")), today,
            country="越南", label=f"{cell.coordinate}: {label}",
        )
        candidates.append((cell.column, label, selected_date, mode))
    if not candidates:
        raise OrderImportWorkbookError("越南工作表没有可识别的 M/D陆运 或 M/D海运 日期字段")
    return candidates


def select_shipping_column(
    sheet: Any,
    today: date,
    override: str | None = None,
) -> tuple[int, str, date, str]:
    candidates = shipping_candidates(sheet, today)
    nearest_distance = min(abs((item[2] - today).days) for item in candidates)
    nearest = [item for item in candidates if abs((item[2] - today).days) == nearest_distance]
    if override is not None:
        normalized = str(override).strip().upper()
        selected = [item for item in nearest if get_column_letter(item[0]) == normalized]
        if not selected:
            choices = ", ".join(f"{item[1]} ({get_column_letter(item[0])})" for item in nearest)
            raise OrderImportWorkbookError(
                f"指定的运输列 {normalized} 不是最近日期候选列；当前候选为: {choices}"
            )
        return selected[0]
    if len(nearest) != 1:
        choices = ", ".join(f"{item[1]} ({get_column_letter(item[0])})" for item in nearest)
        raise OrderImportWorkbookError(f"最近运输日期并列，请人工选择其中一列: {choices}")
    return nearest[0]


def _source_rows(
    input_path: Path,
    today: date,
    shipping_column: str | None,
) -> tuple[list[tuple[str, int | float | None]], tuple[int, str, date, str]]:
    with source_worksheets(input_path, SOURCE_SHEET, input_label="越南备货清单") as (sheet, formula_sheet):
        require_sku_header(sheet, SKU_COLUMN, "越南")
        selected = select_shipping_column(sheet, today, shipping_column)
        quantity_column = selected[0]
        source_rows = read_sku_rows(
            sheet,
            formula_sheet,
            sku_column=SKU_COLUMN,
            quantity_columns={"quantity": quantity_column},
            country="越南",
        )
        rows = [
            (
                sku,
                parse_quantity(
                    quantities["quantity"],
                    coordinate=f"{get_column_letter(quantity_column)}{row_number}",
                    country="越南",
                ),
            )
            for row_number, sku, quantities in source_rows
        ]
    return rows, selected


def generate_order_workbook(
    input_xlsx: str | Path,
    output_xlsx: str | Path,
    *,
    today: date,
    shipping_column: str | None,
    template_path: str | Path,
) -> dict[str, Any]:
    input_path = Path(input_xlsx)
    rows, selected = _source_rows(input_path, today, shipping_column)
    mode = selected[3]
    order_id = f"VN{today:%y%m%d}-{MODE_SUFFIX[mode]}"
    result = write_order_workbook(rows, output_xlsx, order_id=order_id, template_path=template_path)
    return {
        **result,
        "shipping_column": selected[0],
        "shipping_header": selected[1],
        "shipping_date": selected[2].isoformat(),
        "shipping_mode": mode,
    }
