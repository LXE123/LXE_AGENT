"""Read supplied PH8805/PH1 exports; never fetch or regroup TMS records."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from pathlib import Path
from zipfile import ZipFile

from openpyxl import load_workbook
from openpyxl.cell.rich_text import CellRichText
from openpyxl.workbook import Workbook

from services.mabang_tms.workbooks import read_workbook
from services.yacang.validation import (
    INVENTORY_SALES_DELIVERY_HEADERS,
    validate_inventory_list_workbook,
    validate_inventory_sales_workbook,
)
from shared.filesystem import filesystem_path

from .errors import PhilippinesReportError


INVENTORY_HEADERS = (
    "条码", "SKU", "映射条码", "仓库", "规格", "库存数量", "占用数量", "在途数量", "冻结库存", "可用库存",
)
SALES_FIELDS = tuple(f"{days}天销量" for days in (3, 7, 15, 30, 60, 90))
SALES_MAPPING = {**{f"{days}天销量": f"{days}天销量" for days in (7, 15, 30)}, "可用": "可用库存"}
INVENTORY_MAPPING = {"可用库存": "可用库存"}
TMS_NUMBER_FIELDS = frozenset((*SALES_FIELDS, "库存量", "在途量", "可用库存"))


@dataclass
class YacangSource:
    book: Workbook
    rows: dict[str, dict[str, object]]


def number(value: object, *, source: str, sku: str, field: str) -> Decimal | None:
    if isinstance(value, CellRichText):
        value = str(value)
    if value is None or isinstance(value, str) and not value.strip():
        return None
    if isinstance(value, bool):
        raise PhilippinesReportError("invalid_number", f"{source} SKU {sku!r} 的 {field} 不能是布尔值")
    try:
        parsed = Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError) as exc:
        raise PhilippinesReportError(
            "invalid_number", f"{source} SKU {sku!r} 的 {field} 不是数字: {value!r}; {type(exc).__name__}: {exc}",
        ) from exc
    if not parsed.is_finite():
        raise PhilippinesReportError("invalid_number", f"{source} SKU {sku!r} 的 {field} 必须是有限数值: {value!r}")
    return parsed


def _sku(value: object, *, source: str, row_number: int, seen: dict) -> str:
    if isinstance(value, CellRichText):
        value = str(value)
    if not isinstance(value, str) or not value.strip():
        raise PhilippinesReportError("invalid_sku", f"{source} 第 {row_number} 行 SKU 必须是非空文本")
    sku = value.strip()
    if sku in seen:
        raise PhilippinesReportError("duplicate_sku", f"{source} 第 {row_number} 行重复 SKU: {sku!r}；需要每 SKU 一行的来源报表")
    return sku


def _check_xlsx(path: Path) -> Path:
    actual = filesystem_path(path)
    if path.suffix.lower() != ".xlsx" or not actual.is_file():
        raise PhilippinesReportError("invalid_source", f"来源必须是存在的 XLSX 文件: {path}")
    return actual


def load_yacang(path: Path, report: str) -> YacangSource:
    """The returned workbook belongs to the caller and retains the source sheet."""
    book = None
    try:
        actual = _check_xlsx(path)
        with ZipFile(actual) as archive:
            if sum(member.file_size for member in archive.infolist()) > 250_000_000:
                raise PhilippinesReportError("source_size_limit", f"XLSX 解压后超过 250 MB: {path}")
        if report == "inventory-sales":
            validate_inventory_sales_workbook(actual, warehouse_code="PH8805", allow_delivery=True)
            numeric_fields = INVENTORY_SALES_DELIVERY_HEADERS[3:]
        else:
            validate_inventory_list_workbook(actual, warehouse_code="PH8805")
            numeric_fields = INVENTORY_HEADERS[5:]
        book = load_workbook(actual, data_only=False, rich_text=True)
        sheet = book.worksheets[0]
        headers = tuple(str(cell.value or "").strip() for cell in sheet[1])
        rows: dict[str, dict[str, object]] = {}
        for row_number, cells in enumerate(sheet.iter_rows(min_row=2), 2):
            if all(cell.value is None for cell in cells):
                continue
            for cell in cells:
                if cell.data_type in {"f", "e"}:
                    raise PhilippinesReportError(
                        "unexpected_formula", f"雅仓 {report} {cell.coordinate} 包含公式或 Excel 错误，无法作为原始数值合并",
                    )
            values = dict(zip(headers, (cell.value for cell in cells)))
            sku = _sku(values.get("SKU"), source=f"雅仓 {report}", row_number=row_number, seen=rows)
            for field in numeric_fields:
                number(values.get(field), source=f"雅仓 {report}", sku=sku, field=field)
            values["SKU"] = sku
            rows[sku] = values
        return YacangSource(book, rows)
    except Exception as exc:
        if book is not None:
            book.close()
        if isinstance(exc, PhilippinesReportError):
            raise
        raise PhilippinesReportError(
            str(getattr(exc, "code", "invalid_source")),
            f"读取雅仓 {report} 文件失败: {type(exc).__name__}: {exc}",
        ) from exc


def load_tms(path: Path | None, warehouse_name: str) -> tuple[tuple[str, ...], dict[str, dict[str, object]]]:
    if path is None:
        return (), {}
    try:
        actual = _check_xlsx(path)
        headers, raw_rows, _extension = read_workbook(actual.read_bytes())
        rows: dict[str, dict[str, object]] = {}
        for row_number, raw_row in enumerate(raw_rows, 2):
            values = dict(zip(headers, raw_row))
            sku = _sku(values.get("库存SKU"), source="TMS PH1", row_number=row_number, seen=rows)
            if values.get("仓库") != warehouse_name:
                raise PhilippinesReportError(
                    "warehouse_mismatch", f"TMS 第 {row_number} 行仓库为 {values.get('仓库')!r}，预期 {warehouse_name!r}",
                )
            for field in TMS_NUMBER_FIELDS.intersection(headers):
                values[field] = number(values[field], source="TMS PH1", sku=sku, field=field)
            rows[sku] = values
        return headers, rows
    except PhilippinesReportError:
        raise
    except Exception as exc:
        raise PhilippinesReportError(
            str(getattr(exc, "code", "invalid_source")), f"读取 TMS PH1 文件失败: {type(exc).__name__}: {exc}",
        ) from exc
