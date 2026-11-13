"""Build the two Philippines workbooks in a caller-owned staging directory."""

from __future__ import annotations

from contextlib import ExitStack
from copy import copy
from datetime import date
from decimal import Decimal
from itertools import chain
import math
from pathlib import Path

from openpyxl.utils import get_column_letter

from services.yacang.validation import INVENTORY_SALES_DELIVERY_HEADERS
from shared.filesystem import display_path, filesystem_path

from .errors import PhilippinesReportError
from .sources import (
    INVENTORY_HEADERS, INVENTORY_MAPPING, SALES_MAPPING, TMS_NUMBER_FIELDS,
    YacangSource, load_tms, load_yacang,
)


def _merge(source: YacangSource, tms: dict, headers: tuple[str, ...], mapping: dict[str, str], *, inventory: bool, append_skus: dict):
    merged = []
    added = matched = 0
    filter_fields = ("可用库存",) if inventory else ("7天销量", "15天销量", "30天销量")

    for sku, original in source.rows.items():
        values = {header: original.get(header) for header in headers}
        amounts = source.numbers[sku].copy()
        if sku in tms:
            for target, field in mapping.items():
                extra = tms[sku][field]
                if extra is not None:
                    amounts[target] = (amounts[target] or 0) + extra
                    values[target] = amounts[target]
        if any(amounts[field] not in (None, 0) for field in filter_fields):
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
        if any(values[field] not in (None, 0) for field in filter_fields):
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


def _write_report(source, *, path: Path, headers, rows, source_sheet_name: str, sheet_name: str):
    book = source.book
    original = book.worksheets[0]
    original.title = source_sheet_name
    sheet = book.create_sheet(sheet_name)
    sheet.sheet_format = copy(original.sheet_format)
    sheet.views = copy(original.views)
    source_columns = {str(cell.value or "").strip(): cell.column for cell in original[1]}
    column_numbers = [source_columns[header] for header in headers]
    sku_column = source_columns["SKU"]
    source_max_row = original.max_row
    source_rows = {str(original.cell(row, sku_column).value).strip(): row
                   for row in range(2, source_max_row + 1)
                   if original.cell(row, sku_column).value is not None}
    for target_column, source_column in enumerate(column_numbers, 1):
        source_letter = get_column_letter(source_column)
        target_letter = get_column_letter(target_column)
        source_dimension = original.column_dimensions.get(source_letter)
        if source_dimension is None:
            source_dimension = next((dim for dim in original.column_dimensions.values()
                                     if dim.min and dim.max and dim.min <= source_column <= dim.max), None)
        if source_dimension is not None:
            dimension = copy(source_dimension)
            dimension.index = target_letter
            dimension.min = dimension.max = target_column
            sheet.column_dimensions[target_letter] = dimension
    sheet.auto_filter.ref = f"A1:{get_column_letter(len(headers))}{len(rows) + 1}"
    for row_number, row in enumerate(chain((headers,), rows), 1):
        source_row = 1 if row_number == 1 else source_rows.get(row[headers.index("SKU")], 2)
        if source_row in original.row_dimensions:
            dimension = copy(original.row_dimensions[source_row])
            dimension.index = row_number
            sheet.row_dimensions[row_number] = dimension
        sheet.append([_excel_value(value) for value in row])
        for column, source_column in enumerate(column_numbers, 1):
            cell = sheet.cell(row_number, column)
            if source_row <= source_max_row:
                cell._style = copy(original.cell(source_row, source_column)._style)
            if isinstance(cell.value, str):
                cell.data_type = "s"
    book.save(filesystem_path(path))
    return {"path": str(display_path(path.resolve())), "sheet_names": list(book.sheetnames),
            "row_count": len(rows), "source_row_count": len(source.rows)}


def build_reports(
    *, sales_path: Path, inventory_path: Path, tms_path: Path | None,
    output_dir: Path, report_date: date, tms_warehouse_name: str = "菲律宾PH1仓",
) -> dict:
    """Read the exported sources and write both reports, with no network calls.

    ``tms_path=None`` is reserved for an upstream export that proved PH1 empty.
    Publication and temporary-directory cleanup belong to the outer workflow.
    """
    output_dir = filesystem_path(output_dir)
    labels = (("inventory-sales", "菲律宾库存动销", "雅仓动销", "合并动销"),
              ("inventory", "菲律宾库存列表", "雅仓库存", "合并库存"))
    paths = [output_dir / f"{label}-{report_date:%Y年%m月%d日}.xlsx" for _report, label, _source, _sheet in labels]
    with ExitStack() as stack:
        sales = load_yacang(Path(sales_path), "inventory-sales")
        stack.callback(sales.book.close)
        inventory = load_yacang(Path(inventory_path), "inventory")
        stack.callback(inventory.book.close)
        tms_headers, all_tms = load_tms(Path(tms_path) if tms_path is not None else None, tms_warehouse_name)
        mappings = {
            "inventory-sales": SALES_MAPPING if tms_headers else {},
            "inventory": INVENTORY_MAPPING if tms_headers else {},
        }
        active_tms = {sku: values for sku, values in all_tms.items() if any(
            values[field] not in (None, 0) for field in TMS_NUMBER_FIELDS
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
            ]},
        }


__all__ = ["build_reports"]
