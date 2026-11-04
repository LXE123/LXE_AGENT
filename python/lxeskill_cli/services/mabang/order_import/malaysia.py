from __future__ import annotations

from datetime import date
from pathlib import Path
import re
from typing import Any

from openpyxl.utils import get_column_letter

from .source import nearest_occurrence, parse_quantity, read_sku_rows, require_sku_header, source_worksheets
from .workbook import OrderImportWorkbookError, generate_order_workbook


SOURCE_SHEET = "马来西亚"
SKU_COLUMN = 5  # E
HEADER = re.compile(
    r"^(?P<month>[0-9]{1,2})/(?P<day>[0-9]{1,2})(?P<batch>[AB])?(?P<kind>空运|海运)$",
    re.IGNORECASE,
)
REQUIRED_FIELDS = ("sea_a", "sea_b", "air")
FIELD_SUFFIX = {"air": "-K", "sea_a": "A-H", "sea_b": "B-H"}


def select_shipping_columns(sheet: Any, today: date) -> dict[str, tuple[int, str, date]]:
    groups: dict[date, dict[str, tuple[int, str, date]]] = {}
    for cell in sheet[1]:
        label = str(cell.value or "").strip()
        if not label:
            continue
        match = HEADER.fullmatch(label)
        if match is None:
            if "/" in label and ("空运" in label or "海运" in label):
                raise OrderImportWorkbookError(f"马来西亚工作表第1行 {cell.coordinate} 运输日期字段格式无效: {label}")
            continue
        batch = match.group("batch")
        kind = match.group("kind")
        if kind == "空运" and batch is None:
            field = "air"
        elif kind == "海运" and batch in {"A", "a"}:
            field = "sea_a"
        elif kind == "海运" and batch in {"B", "b"}:
            field = "sea_b"
        else:
            raise OrderImportWorkbookError(f"马来西亚工作表第1行 {cell.coordinate} 运输字段缺少有效批次标记: {label}")
        shipping_date = nearest_occurrence(
            int(match.group("month")), int(match.group("day")), today,
            country="马来西亚", label=f"{cell.coordinate}: {label}",
        )
        group = groups.setdefault(shipping_date, {})
        if field in group:
            previous = group[field]
            raise OrderImportWorkbookError(
                f"马来西亚工作表 {shipping_date.isoformat()} 的 {label} 字段重复："
                f"{previous[1]} 与 {cell.coordinate}"
            )
        group[field] = (cell.column, label, shipping_date)

    if not groups:
        raise OrderImportWorkbookError("马来西亚工作表没有可识别的空运/A海运/B海运日期字段")
    latest = max(groups)
    selected = groups[latest]
    missing = [field for field in REQUIRED_FIELDS if field not in selected]
    if missing:
        names = {"air": "空运", "sea_a": "A海运", "sea_b": "B海运"}
        raise OrderImportWorkbookError(
            f"最新日期组 {latest.isoformat()} 缺少字段: {', '.join(names[field] for field in missing)}"
        )
    return selected


def _source_rows(
    input_path: Path,
    today: date,
) -> tuple[list[tuple[str, dict[str, Any]]], dict[str, tuple[int, str, date]]]:
    with source_worksheets(input_path, SOURCE_SHEET) as (sheet, formula_sheet):
        require_sku_header(sheet, SKU_COLUMN, "马来西亚")
        selected = select_shipping_columns(sheet, today)
        source_rows = read_sku_rows(
            sheet,
            formula_sheet,
            sku_column=SKU_COLUMN,
            quantity_columns={field: column for field, (column, _, _) in selected.items()},
            country="马来西亚",
        )
        rows = [
            (sku, {
                field: parse_quantity(
                    value, coordinate=f"{get_column_letter(selected[field][0])}{row_number}", country="马来西亚",
                )
                for field, value in quantities.items()
            })
            for row_number, sku, quantities in source_rows
        ]
    return rows, selected


def generate_order_workbooks(
    input_xlsx: str | Path,
    output_directory: str | Path,
    *,
    today: date,
    template_path: str | Path,
) -> list[dict[str, Any]]:
    input_path = Path(input_xlsx)
    rows, selected = _source_rows(input_path, today)
    output_dir = Path(output_directory)
    artifacts: list[dict[str, Any]] = []
    for field in REQUIRED_FIELDS:
        order_id = f"MY{today:%y%m%d}{FIELD_SUFFIX[field]}"
        output = output_dir / f"马来西亚马帮订单导入模板-{order_id}.xlsx"
        field_rows = [(sku, quantities[field]) for sku, quantities in rows]
        result = generate_order_workbook(field_rows, output, order_id=order_id, template_path=template_path)
        column, header, shipping_date = selected[field]
        artifacts.append(
            {
                **result,
                "field": field,
                "shipping_column": column,
                "shipping_header": header,
                "shipping_date": shipping_date.isoformat(),
            }
        )
    return artifacts
