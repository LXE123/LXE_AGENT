"""Build the two Philippines workbooks in a caller-owned staging directory."""

from __future__ import annotations

from contextlib import ExitStack
from copy import copy
from datetime import date
from decimal import Decimal
from itertools import chain
import math
from pathlib import Path

from openpyxl import load_workbook
from openpyxl.styles import Font, PatternFill
from openpyxl.utils import get_column_letter

from services.yacang.validation import INVENTORY_SALES_DELIVERY_HEADERS
from shared.filesystem import display_path, filesystem_path

from .errors import PhilippinesReportError
from .sources import (
    INVENTORY_HEADERS, INVENTORY_MAPPING, SALES_MAPPING, TMS_NUMBER_FIELDS,
    YacangSource, load_tms, load_yacang, number,
)


def _add(base: object, extra: Decimal | None, *, sku: str, field: str) -> object:
    if extra is None:
        return base
    current = number(base, source="雅仓", sku=sku, field=field)
    return extra if current is None else current + extra


def _merge(source: YacangSource, tms: dict, headers: tuple[str, ...], mapping: dict[str, str], *, inventory: bool, append_skus: dict):
    merged = []
    added = matched = 0
    filter_fields = ("可用库存",) if inventory else ("7天销量", "15天销量", "30天销量")

    def keep(values, sku):
        return any(number(values[field], source="合并", sku=sku, field=field) not in (None, 0)
                   for field in filter_fields)

    for sku, original in source.rows.items():
        values = {header: original.get(header) for header in headers}
        if sku in tms:
            for target, field in mapping.items():
                values[target] = _add(values[target], tms[sku][field], sku=sku, field=target)
        if keep(values, sku):
            merged.append(tuple(values[header] for header in headers))
            matched += sku in tms
    for sku, extra in append_skus.items():
        if sku in source.rows:
            continue
        values = {header: None for header in headers}
        values["SKU"] = sku
        if inventory:
            values["映射条码"] = sku
        for target, field in mapping.items():
            values[target] = extra[field]
        if keep(values, sku):
            merged.append(tuple(values[header] for header in headers))
            added += 1
    return merged, added, matched


def _excel_value(value: object) -> object:
    if isinstance(value, Decimal):
        result = int(value) if value == value.to_integral_value() else float(value)
        if isinstance(result, float) and not math.isfinite(result):
            raise PhilippinesReportError("invalid_number", "合并后的数值超出 Excel 可写入的有限数值范围")
        return result
    return value


def _sheet_snapshot(sheet):
    """Capture source values and cell styles before adding the result worksheet."""
    return {
        "title": sheet.title,
        "cells": tuple(tuple(
            (None if cell.value in (None, "") else cell.value,
             None if cell.value in (None, "") else cell.data_type,
             copy(cell._style) if cell.has_style else None) for cell in row
        ) for row in sheet.iter_rows()),
        "rows": {key: (value.height, value.hidden, value.outlineLevel) for key, value in sheet.row_dimensions.items()},
        "columns": {key: (value.width, value.hidden, value.min, value.max) for key, value in sheet.column_dimensions.items()},
        "merged": str(sheet.merged_cells),
        "freeze": sheet.freeze_panes,
        "filter": sheet.auto_filter.ref,
    }


def _verify_output(path: Path, original, headers, rows, sheet_name):
    with filesystem_path(path).open("rb") as stream:
        book = load_workbook(stream, data_only=False, rich_text=True)
    try:
        if book.sheetnames != [original["title"], sheet_name] or _sheet_snapshot(book.worksheets[0]) != original:
            raise PhilippinesReportError("output_validation_failed", f"{path.name} 未保留雅仓原表的内容或格式")
        sheet = book.worksheets[1]
        expected = [tuple(headers), *[tuple(_excel_value(value) for value in row) for row in rows]]
        actual = list(sheet.iter_rows(values_only=True))
        if actual != expected:
            raise PhilippinesReportError("output_validation_failed", f"{path.name} 合并表保存后的数据与计算结果不一致")
        if any(cell.data_type in {"f", "e"} for row in sheet for cell in row):
            raise PhilippinesReportError("output_validation_failed", f"{path.name} 合并表出现公式或错误单元格")
    finally:
        book.close()


def _write_report(source, *, path: Path, headers, rows, source_sheet_name: str, sheet_name: str):
    book = source.book
    original = _sheet_snapshot(book.worksheets[0])
    book.worksheets[0].title = source_sheet_name
    original["title"] = source_sheet_name
    sheet = book.create_sheet(sheet_name)
    sheet.freeze_panes = "A2"
    sheet.auto_filter.ref = f"A1:{get_column_letter(len(headers))}{len(rows) + 1}"
    for row_number, row in enumerate(chain((headers,), rows), 1):
        sheet.append([_excel_value(value) for value in row])
        for column in range(1, len(headers) + 1):
            cell = sheet.cell(row_number, column)
            if isinstance(cell.value, str):
                cell.data_type = "s"
    for cell in sheet[1]:
        cell.font = Font(bold=True, color="FFFFFF")
        cell.fill = PatternFill(fill_type="solid", fgColor="24476A")
    for index, header in enumerate(headers, 1):
        width = 40 if header == "商品名" else 26 if header in {"SKU", "条码", "映射条码", "规格"} else 16
        sheet.column_dimensions[get_column_letter(index)].width = width
    book.save(filesystem_path(path))
    _verify_output(path, original, headers, rows, sheet_name)
    return {"path": str(display_path(path.resolve())), "sheet_names": list(book.sheetnames),
            "row_count": len(rows), "source_row_count": len(source.rows)}


def build_reports(
    *, sales_path: Path, inventory_path: Path, tms_path: Path | None,
    output_dir: Path, report_date: date, tms_warehouse_name: str = "菲律宾PH1仓",
) -> dict:
    """Read three supplied snapshots and write both reports, with no network calls.

    ``tms_path=None`` is reserved for an upstream export that proved PH1 empty.
    Publication and input snapshots belong to the outer workflow.
    """
    output_dir = filesystem_path(output_dir)
    labels = (("inventory-sales", "菲律宾库存动销", "雅仓动销", "合并动销"),
              ("inventory", "菲律宾库存列表", "雅仓库存", "合并库存"))
    paths = [output_dir / f"{label}-{report_date:%Y年%m月%d日}.xlsx" for _report, label, _source, _sheet in labels]
    if any(path.exists() for path in paths):
        raise PhilippinesReportError("output_exists", "目标目录已存在同名菲律宾报表，不能覆盖")
    created = []
    try:
        with ExitStack() as stack:
            sales = load_yacang(Path(sales_path), "inventory-sales")
            stack.callback(sales.book.close)
            inventory = load_yacang(Path(inventory_path), "inventory")
            stack.callback(inventory.book.close)
            tms_headers, all_tms = load_tms(Path(tms_path) if tms_path is not None else None, tms_warehouse_name)
            mappings = {
                "inventory-sales": {target: field for target, field in SALES_MAPPING.items() if field in tms_headers},
                "inventory": {target: field for target, field in INVENTORY_MAPPING.items() if field in tms_headers},
            }
            active_tms = {sku: values for sku, values in all_tms.items() if any(
                values.get(field) not in (None, 0) for field in TMS_NUMBER_FIELDS.intersection(tms_headers)
            )}
            sales_rows, sales_added, sales_matched = _merge(
                sales, all_tms, INVENTORY_SALES_DELIVERY_HEADERS, mappings["inventory-sales"],
                inventory=False, append_skus=active_tms,
            )
            inventory_rows, inventory_added, inventory_matched = _merge(
                inventory, all_tms, INVENTORY_HEADERS, mappings["inventory"],
                inventory=True, append_skus=active_tms,
            )
            output_dir.mkdir(parents=True, exist_ok=True)
            artifacts = []
            for path, (report, _label, source_sheet_name, sheet_name), source, headers, rows in zip(
                paths, labels, (sales, inventory), (INVENTORY_SALES_DELIVERY_HEADERS, INVENTORY_HEADERS),
                (sales_rows, inventory_rows),
            ):
                created.append(path)
                artifact = _write_report(source, path=path, headers=headers, rows=rows,
                                         source_sheet_name=source_sheet_name, sheet_name=sheet_name)
                artifacts.append({**artifact, "report": report})
            return {
                "artifacts": artifacts,
                "statistics": {
                    "yacang_sales_rows": len(sales.rows), "yacang_inventory_rows": len(inventory.rows),
                    "tms_rows": len(all_tms), "tms_zero_or_empty_rows": len(all_tms) - len(active_tms),
                    "sales_added_rows": sales_added, "inventory_added_rows": inventory_added,
                    "sales_matched_rows": sales_matched, "inventory_matched_rows": inventory_matched,
                },
                "field_mappings": mappings,
                "validation": {"status": "passed", "checks": [
                    "source_schema", "warehouse_scope", "unique_skus", "finite_numbers",
                    "original_sheet_preserved", "merged_values", "output_round_trip",
                ]},
            }
    except Exception as exc:
        for path in created:
            try:
                path.unlink(missing_ok=True)
            except OSError as cleanup:
                exc.add_note(f"清理临时报表 {path.name} 失败: {type(cleanup).__name__}: {cleanup}")
        raise


__all__ = ["build_reports"]
