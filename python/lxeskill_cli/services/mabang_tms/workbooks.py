from __future__ import annotations

import io
import math
import os
from collections import Counter
from datetime import date, datetime, time, timezone
from itertools import chain
from pathlib import Path
from zipfile import ZipFile, is_zipfile

import xlrd
from openpyxl import Workbook, load_workbook
from openpyxl.cell import WriteOnlyCell

from .client import TmsError

REQUIRED_HEADERS = {"库存SKU", "30天销量", "7天销量", "可用库存", "15天销量", "仓库",
                    "库存量", "在途量", "成本价", "采购价", "入库时间"}
XLS_SIGNATURE = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"


def read_workbook(content):
    if content.startswith(XLS_SIGNATURE):
        wb = xlrd.open_workbook(file_contents=content, on_demand=True)
        try:
            if wb.nsheets != 1:
                raise TmsError("unexpected_sheets", f"导出文件工作表数为 {wb.nsheets}，预期 1")
            sheet = wb.sheet_by_index(0)
            rows = []
            for i in range(sheet.nrows):
                row = []
                for cell in sheet.row(i):
                    if cell.ctype == xlrd.XL_CELL_ERROR:
                        raise TmsError("cell_error", f"源表第 {i + 1} 行包含 Excel 错误")
                    row.append(xlrd.xldate.xldate_as_datetime(cell.value, wb.datemode)
                               if cell.ctype == xlrd.XL_CELL_DATE else cell.value)
                rows.append(row)
        finally:
            wb.release_resources()
        extension = "xls"
    elif is_zipfile(io.BytesIO(content)):
        with ZipFile(io.BytesIO(content)) as archive:
            if sum(i.file_size for i in archive.infolist()) > 250_000_000:
                raise TmsError("workbook_size_limit", "XLSX 解压后超过 250 MB")
        wb = load_workbook(io.BytesIO(content), read_only=True, data_only=False)
        try:
            if len(wb.sheetnames) != 1:
                raise TmsError("unexpected_sheets", f"导出文件工作表为 {wb.sheetnames}，预期 1 张")
            rows = []
            for row in wb.active.iter_rows():
                if any(cell.data_type in {"f", "e"} for cell in row):
                    raise TmsError("unexpected_formula", "平台原表含公式或错误单元格，无法作为原始值合并")
                rows.append([c.value for c in row])
        finally:
            wb.close()
        extension = "xlsx"
    else:
        raise TmsError("invalid_workbook", "下载文件头不是 XLS/XLSX")
    if not rows:
        raise TmsError("missing_headers", "导出文件为空")
    headers = rows[0]
    if any(not isinstance(h, str) or not h for h in headers) or len(set(headers)) != len(headers):
        raise TmsError("invalid_headers", f"导出表头为空或重复: {headers}")
    if not REQUIRED_HEADERS.issubset(headers):
        raise TmsError("missing_headers", f"实际表头 {headers}; 缺少 {sorted(REQUIRED_HEADERS - set(headers))}")
    values = [tuple(row) for row in rows[1:] if any(v not in (None, "") for v in row)]
    if any(len(row) != len(headers) for row in values):
        raise TmsError("invalid_row", "导出行宽与表头不一致")
    return tuple(headers), values, extension


def coverage(records, headers, rows):
    """Require each inventory record's pair, allowing one ID to expand to rows.

    Without exported record IDs this is a multiplicity lower bound, not a proof
    of record identity or the exact number of rows produced by each ID.
    """
    expected = Counter()
    for record in records:
        sku = record.get("stockSku")
        warehouse = record.get("warehouseName") or record.get("warehouse")
        if not isinstance(sku, str) or not sku.strip() or not isinstance(warehouse, str) or not warehouse:
            raise TmsError("coverage_schema_unknown", f"无法核对列表 SKU/仓库字段，实际字段: {sorted(record)}")
        expected[(sku.strip(), warehouse)] += 1
    sku_index, warehouse_index = headers.index("库存SKU"), headers.index("仓库")
    actual = Counter((row[sku_index].strip() if isinstance(row[sku_index], str) else row[sku_index],
                      row[warehouse_index]) for row in rows)
    if actual.keys() != expected.keys():
        raise TmsError("coverage_mismatch", f"批次商品/仓库覆盖不一致: 缺少 {len(expected.keys() - actual.keys())}，多出 {len(actual.keys() - expected.keys())}")
    missing = expected - actual
    if missing:
        raise TmsError("coverage_count_mismatch", f"批次商品/仓库记录行数不足: 缺少至少 {sum(missing.values())} 行，涉及 {len(missing)} 组 SKU/仓库")


def _robot_number(value, field):
    if value is None or isinstance(value, str) and not value.strip():
        return 0
    if isinstance(value, bool):
        raise TmsError("invalid_number", f"TMS {field} 数值不能是布尔值: {value!r}")
    try:
        numeric = float(value)
    except (TypeError, ValueError, OverflowError) as exc:
        raise TmsError("invalid_number", f"TMS {field} 数值无效: {value!r}; {type(exc).__name__}: {exc}") from exc
    if not math.isfinite(numeric):
        raise TmsError("invalid_number", f"TMS {field} 必须是有限数值: {value!r}")
    return int(numeric) if numeric.is_integer() else numeric


def _inbound_time(value):
    if value in (None, ""):
        return datetime.min
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, date):
        parsed = datetime.combine(value, time.min)
    elif isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.strip())
        except ValueError as exc:
            raise TmsError("invalid_inbound_time", f"无法判断最新入库记录，入库时间无效: {value!r}") from exc
    else:
        raise TmsError("invalid_inbound_time", f"无法判断最新入库记录，入库时间类型无效: {value!r}")
    return parsed.astimezone(timezone.utc).replace(tzinfo=None) if parsed.tzinfo else parsed


def merge_inventory_export(headers, rows, records):
    """Keep original columns and latest details, replacing robot inventory/sales."""
    required = {"库存SKU", "仓库", "可用库存", "7天销量", "15天销量", "30天销量", "入库时间"}
    if not required.issubset(headers):
        raise TmsError("missing_headers", f"库存动销合并缺少字段: {sorted(required - set(headers))}")
    indexes = {name: headers.index(name) for name in required}
    originals = {}
    for row in rows:
        sku = str(row[indexes["库存SKU"]] or "").strip()
        if sku:
            originals.setdefault((row[indexes["仓库"]], sku), []).append(row)

    summaries, warehouse_ids = {}, {}
    for record in records:
        sku = str(record.get("stockSku") or "").strip()
        if not sku:
            continue
        warehouse = record.get("warehouseName") or record.get("warehouse")
        if not isinstance(warehouse, str) or not warehouse:
            raise TmsError("coverage_schema_unknown", "列表记录缺少可用于合表的仓库名称")
        warehouse_id = record.get("warehouseId")
        if isinstance(warehouse_id, (str, int)) and not isinstance(warehouse_id, bool):
            warehouse_ids.setdefault(warehouse, set()).add(str(warehouse_id))
            if len(warehouse_ids[warehouse]) > 1:
                raise TmsError("ambiguous_warehouse_name", f"多个仓库 ID 使用相同名称，无法安全合表: {warehouse!r}")
        item = summaries.setdefault((warehouse, sku), {"stock": 0, "sale1": None, "sale2": None, "sale3": None})
        item["stock"] += _robot_number(record.get("stockQuantity"), "stockQuantity")
        for field in ("sale1", "sale2", "sale3"):
            value = record.get(field)
            if value not in (None, ""):
                parsed = _robot_number(value, field)
                if item[field] in (None, ""):
                    item[field] = parsed
    if originals.keys() != summaries.keys():
        raise TmsError("coverage_mismatch", "原始明细与机器人列表的仓库/SKU 覆盖不一致，无法合表")

    merged = []
    for (warehouse, sku), summary in summaries.items():
        candidates = originals[(warehouse, sku)]
        latest = max(candidates, key=lambda row: _inbound_time(row[indexes["入库时间"]])) if len(candidates) > 1 else candidates[0]
        row = list(latest)
        row[indexes["库存SKU"]] = sku
        row[indexes["可用库存"]] = summary["stock"]
        for header, field in (("7天销量", "sale1"), ("15天销量", "sale2"), ("30天销量", "sale3")):
            row[indexes[header]] = 0 if summary[field] is None else summary[field]
        merged.append(row)
    return merged


def atomic_bytes(path: Path, content: bytes):
    temporary = path.with_name("." + path.name + ".tmp")
    try:
        with temporary.open("xb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def write_merged(path: Path, headers, rows):
    wb = Workbook(write_only=True)
    sheet = wb.create_sheet("商品")
    for row in chain((headers,), rows):
        cells = [WriteOnlyCell(sheet, value=value) for value in row]
        # Preserve text beginning with '=' as text, never turn platform data into formulas.
        for cell, value in zip(cells, row):
            if isinstance(value, str):
                cell.data_type = "s"
        sheet.append(cells)
    try:
        stream = io.BytesIO()
        wb.save(stream)
        atomic_bytes(path, stream.getvalue())
    finally:
        wb.close()
