"""Build the two Philippines workbooks in a caller-owned staging directory."""

from __future__ import annotations

from contextlib import ExitStack
from datetime import date
from decimal import Decimal
from itertools import chain
import math
from pathlib import Path

from openpyxl.styles import Font, PatternFill
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
    book.worksheets[0].title = source_sheet_name
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
