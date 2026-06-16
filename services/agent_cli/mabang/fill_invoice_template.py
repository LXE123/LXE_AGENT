from __future__ import annotations

import argparse
import asyncio
import copy
import csv
import json
import re
import sys
from collections import OrderedDict
from dataclasses import dataclass, replace
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from io import BytesIO
from pathlib import Path
from typing import Any

from services.agent_cli._shared.json_output import configure_utf8_stdio
from services.agent_cli.mabang.fill_customs_declaration import (
    SourceDeclarationRow,
    _clean_cell,
    classify_declaration,
    extract_destination_country_from_filename,
    extract_sp_no_from_filename,
)
from services.agent_cli.mabang.restock_workbook import (
    MERGE_DETAIL_HEADERS,
    SUMMARY_HEADERS,
    find_merge_detail_sheet,
    find_summary_sheet,
    summary_column_indexes,
)
from services.amazon.amazon_logistic.sources.consignment_excel import (
    find_consignment_excel,
    resolve_column,
)
from services.mabang.stock_sku_export import (
    STOCK_SKU_COLUMN,
    export_stock_sku_names,
    normalize_sku_key,
)
from shared.infra.net import close_all_network_clients

SOURCE = "invoice_template_fill"
DEFAULT_TEMPLATE_PATH = Path("data") / "invoice_Template" / "invoice_Template.xlsx"
DEFAULT_OUTPUT_DIR = Path("artifacts") / "invoice_template"
STOCK_SKU_OUTPUT_DIR = Path("artifacts") / "mabang_stock_sku"
DELIVERY_CSV_DIR = Path("artifacts") / "mabang_fba_delivery"
INVOICE_TEMPLATE_SHEET = "WS-通用发票导入模版"
STOCK_SKU_IMAGE_COLUMN = "库存sku图片"
DELIVERY_MSKU_COLUMN = "MSKU"
SKU_SHIP_QTY_COLUMN = "SKU发货量"
CONSIGNMENT_MSKU_COLUMN = "MSKU"
CONSIGNMENT_QUANTITY_COLUMN = "装箱数量"
CONSIGNMENT_BOX_ALIASES = ("箱序号", "箱子编号", "箱号", "Box No", "Box Number")
CONSIGNMENT_LENGTH_ALIASES = ("长", "长度", "Length", "length")
CONSIGNMENT_WIDTH_ALIASES = ("宽", "Width", "width")
CONSIGNMENT_HEIGHT_ALIASES = ("高", "Height", "height")
CONSIGNMENT_GROSS_WEIGHT_ALIASES = ("毛重", "Gross Weight", "gross_weight", "weight")
ITEM_SPLIT_PATTERN = re.compile(r"[，,\r\n;；]+")
SKU_QTY_PATTERN = re.compile(r"^\s*(?P<sku>.+?)\s*(?:×|x|X|\*)\s*(?P<qty>\d+(?:\.\d+)?)\s*$")
IMAGE_MAX_WIDTH = 80
IMAGE_MAX_HEIGHT = 80
IMAGE_ROW_HEIGHT = 65
IMAGE_COLUMN_WIDTH = 14
UNKNOWN_DECLARED_PRICE_TEXT = "没有该材质的计算价格方式"
INPUT_HEADERS = SUMMARY_HEADERS
MERGE_PRICE_QUANTIZE = Decimal("0.01")
MATERIAL_TRANSLATIONS = {
    "硅胶": "silicone",
    "尼龙": "nylon",
    "贱金属": "base metal",
    "金属": "metal",
    "纸质+塑料": "paper+plastic",
    "皮革": "leather",
    "PC": "PC",
    "TPU": "TPU",
}

INVOICE_TEMPLATE_HEADERS = (
    "货箱编号*",
    "PO Number*",
    "单件货箱重量(KG)*",
    "货箱长度(CM)*",
    "货箱宽度(CM)*",
    "货箱高度(CM)*",
    "产品英文品名*",
    "产品中文品名*",
    "产品申报单价*",
    "单箱产品申报数量*",
    "单位*",
    "产品材质*",
    "产品海关编码*",
    "产品用途*",
    "产品品牌*",
    "品牌类型*",
    "产品型号*",
    "产品销售链接*",
    "产品图片*",
    "预计配送时间段*",
)


@dataclass(frozen=True)
class InvoiceSourceRow:
    row_number: int
    sku: str
    source_name: str
    model: str
    quantity: Any
    purchase_price: Any
    commodity_name: str
    sale_price: Any
    total_price: Any
    unit: str

    def to_declaration_row(self) -> SourceDeclarationRow:
        return SourceDeclarationRow(
            row_number=self.row_number,
            source_name=self.source_name,
            model=self.model,
            quantity=self.quantity,
            commodity_name=self.commodity_name,
            sale_price=self.sale_price,
            total_price=self.total_price,
            unit=self.unit,
        )


@dataclass(frozen=True)
class ConsignmentBoxInfo:
    box_no: str
    gross_weight: str
    length: str
    width: str
    height: str


@dataclass(frozen=True)
class ConsignmentMskuRow:
    row_number: int
    box_info: ConsignmentBoxInfo
    msku: str
    quantity: Decimal


@dataclass(frozen=True)
class InvoiceBoxRow:
    source: InvoiceSourceRow
    box_info: ConsignmentBoxInfo
    quantity: Decimal


@dataclass(frozen=True)
class StockSkuMergeInfo:
    row_number: int
    sku: str
    merge_key: tuple[str, Decimal]
    quantity: Decimal


class JsonArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise ValueError(str(message or "").strip() or "参数解析失败")


def _write_json(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(dict(payload or {}), ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _exception_text(exc: Exception) -> str:
    message = str(exc or "").strip()
    return message or exc.__class__.__name__


def _load_workbook(path: str | Path, *, data_only: bool = False):
    try:
        from openpyxl import load_workbook
    except Exception as exc:
        raise RuntimeError("缺少 openpyxl 依赖，无法处理 xlsx 文件") from exc

    source_path = Path(path).expanduser()
    try:
        return load_workbook(source_path, data_only=data_only)
    except Exception as exc:
        raise RuntimeError(f"读取 xlsx 文件失败: {source_path}, error={exc}") from exc


def read_invoice_source_rows(input_xlsx: str | Path) -> list[InvoiceSourceRow]:
    path = Path(input_xlsx).expanduser()
    if not path.is_file():
        raise FileNotFoundError(f"输入 xlsx 不存在: {path}")

    workbook = _load_workbook(path, data_only=True)
    try:
        worksheet = find_summary_sheet(workbook, path)
        column_indexes = summary_column_indexes(worksheet, input_path=path, sheet_name=worksheet.title)

        rows: list[InvoiceSourceRow] = []
        for row_number in range(2, worksheet.max_row + 1):
            if not _clean_cell(worksheet.cell(row=row_number, column=column_indexes["日期"]).value):
                break
            rows.append(
                InvoiceSourceRow(
                    row_number=row_number,
                    sku=_clean_cell(worksheet.cell(row=row_number, column=column_indexes["SKU"]).value),
                    source_name=_clean_cell(worksheet.cell(row=row_number, column=column_indexes["品名"]).value),
                    model=_clean_cell(worksheet.cell(row=row_number, column=column_indexes["规格型号"]).value),
                    quantity=worksheet.cell(row=row_number, column=column_indexes["发货量"]).value,
                    purchase_price=worksheet.cell(row=row_number, column=column_indexes["单价"]).value,
                    commodity_name=_clean_cell(worksheet.cell(row=row_number, column=column_indexes["商品名称"]).value),
                    sale_price=worksheet.cell(row=row_number, column=column_indexes["售价"]).value,
                    total_price=worksheet.cell(row=row_number, column=column_indexes["总价"]).value,
                    unit=_clean_cell(worksheet.cell(row=row_number, column=column_indexes["单位"]).value),
                )
            )
        if not rows:
            raise ValueError(f"输入 xlsx 的 sheet {worksheet.title} 未解析到有效数据: {path.name}")
        return rows
    finally:
        workbook.close()


def read_stock_sku_merge_infos(input_xlsx: str | Path) -> OrderedDict[str, StockSkuMergeInfo]:
    path = Path(input_xlsx).expanduser()
    if not path.is_file():
        raise FileNotFoundError(f"输入 xlsx 不存在: {path}")

    workbook = _load_workbook(path, data_only=True)
    try:
        worksheet = find_merge_detail_sheet(workbook, path)
        column_indexes = {header: index + 1 for index, header in enumerate(MERGE_DETAIL_HEADERS)}

        merge_infos: OrderedDict[str, StockSkuMergeInfo] = OrderedDict()
        conflicting_skus: list[str] = []
        for row_number in range(2, worksheet.max_row + 1):
            sku = _clean_cell(worksheet.cell(row=row_number, column=column_indexes["SKU"]).value)
            if not sku:
                continue
            sku_key = normalize_sku_key(sku)
            if not sku_key:
                continue
            row_context = f"财务合并明细表 {worksheet.title} 第{row_number}行 SKU={sku}"
            model = _clean_cell(worksheet.cell(row=row_number, column=column_indexes["规则型号"]).value)
            if not model:
                raise ValueError(f"{row_context} 缺少规则型号")
            price = _normalized_price_key(
                worksheet.cell(row=row_number, column=column_indexes["单价"]).value,
                row_context=row_context,
            )
            quantity = _parse_decimal(
                worksheet.cell(row=row_number, column=column_indexes["发货量"]).value,
                field_name="发货量",
                row_context=row_context,
            )
            merge_key = (model, price)
            existing = merge_infos.get(sku_key)
            if existing is not None:
                if existing.merge_key != merge_key:
                    conflicting_skus.append(
                        f"{sku}: {_merge_key_text(existing.merge_key)} / {_merge_key_text(merge_key)}"
                    )
                    continue
                merge_infos[sku_key] = StockSkuMergeInfo(
                    row_number=existing.row_number,
                    sku=existing.sku,
                    merge_key=existing.merge_key,
                    quantity=existing.quantity + quantity,
                )
                continue
            merge_infos[sku_key] = StockSkuMergeInfo(
                row_number=row_number,
                sku=sku,
                merge_key=merge_key,
                quantity=quantity,
            )
        if conflicting_skus:
            preview = "; ".join(conflicting_skus[:10])
            suffix = " ..." if len(conflicting_skus) > 10 else ""
            raise ValueError(f"财务合并明细表同一 SKU 存在不同规则型号或单价，无法建立合并映射: {preview}{suffix}")
        if not merge_infos:
            raise ValueError(f"财务合并明细表 {worksheet.title} 未解析到有效库存 SKU 合并明细")
        return merge_infos
    finally:
        workbook.close()


def infer_missing_summary_models(
    source_rows: list[InvoiceSourceRow],
    stock_sku_merge_infos: OrderedDict[str, StockSkuMergeInfo],
) -> tuple[list[InvoiceSourceRow], list[str]]:
    inferred_rows: list[InvoiceSourceRow] = []
    notices: list[str] = []
    for row in source_rows:
        if _clean_cell(row.model):
            inferred_rows.append(row)
            continue
        sku_key = normalize_sku_key(row.sku)
        if not sku_key:
            raise ValueError(f"汇总表第{row.row_number}行 SKU 不能为空，无法补全规格型号")
        merge_info = stock_sku_merge_infos.get(sku_key)
        if merge_info is None:
            raise ValueError(f"汇总表第{row.row_number}行 SKU={row.sku} 规格型号为空，且财务合并明细表找不到同 SKU")
        summary_price = _normalized_price_key(
            row.purchase_price,
            row_context=f"汇总表第{row.row_number}行 SKU={row.sku}",
        )
        merge_model, merge_price = merge_info.merge_key
        if summary_price != merge_price:
            raise ValueError(
                f"汇总表第{row.row_number}行 SKU={row.sku} 规格型号为空，"
                "但财务合并明细表同 SKU 单价不一致: "
                f"汇总表单价={_decimal_sort_text(summary_price)}, "
                f"财务合并明细表单价={_decimal_sort_text(merge_price)}"
            )
        inferred_rows.append(replace(row, model=merge_model))
        notices.append(f"汇总表第{row.row_number}行 SKU={row.sku} 规格型号为空，已按财务合并明细表补为 {merge_model}")
    return inferred_rows, notices


def unique_source_skus(rows: list[InvoiceSourceRow]) -> list[str]:
    unique: OrderedDict[str, str] = OrderedDict()
    for row in rows:
        key = normalize_sku_key(row.sku)
        if not key or key in unique:
            continue
        unique[key] = row.sku
    return list(unique.values())


def _source_rows_by_sku(rows: list[InvoiceSourceRow]) -> OrderedDict[str, InvoiceSourceRow]:
    by_key: OrderedDict[str, InvoiceSourceRow] = OrderedDict()
    duplicate_skus: list[str] = []
    for row in rows:
        key = normalize_sku_key(row.sku)
        if not key:
            raise ValueError(f"第{row.row_number}行 SKU 不能为空")
        if key in by_key:
            duplicate_skus.append(row.sku)
            continue
        by_key[key] = row
    if duplicate_skus:
        preview = ", ".join(duplicate_skus[:10])
        suffix = " ..." if len(duplicate_skus) > 10 else ""
        raise ValueError(f"备货单 SKU 存在重复，无法按装箱数据拆分: {preview}{suffix}")
    return by_key


def _merge_key_text(merge_key: tuple[str, Decimal]) -> str:
    return f"规则型号={merge_key[0]}, 单价={_decimal_sort_text(merge_key[1])}"


def _merge_key_for_source_row(row: InvoiceSourceRow) -> tuple[str, Decimal]:
    model = _clean_cell(row.model)
    if not model:
        raise ValueError(f"汇总表第{row.row_number}行 SKU={row.sku} 缺少规格型号")
    price = _normalized_price_key(
        row.purchase_price,
        row_context=f"汇总表第{row.row_number}行 SKU={row.sku}",
    )
    return model, price


def _source_rows_by_merge_key(rows: list[InvoiceSourceRow]) -> OrderedDict[tuple[str, Decimal], InvoiceSourceRow]:
    by_key: OrderedDict[tuple[str, Decimal], InvoiceSourceRow] = OrderedDict()
    duplicates: list[str] = []
    for row in rows:
        sku_key = normalize_sku_key(row.sku)
        if not sku_key:
            raise ValueError(f"汇总表第{row.row_number}行 SKU 不能为空")
        merge_key = _merge_key_for_source_row(row)
        if merge_key in by_key:
            existing_sku_key = normalize_sku_key(by_key[merge_key].sku)
            if existing_sku_key == sku_key:
                continue
            duplicates.append(f"{_merge_key_text(merge_key)}: {by_key[merge_key].sku}, {row.sku}")
            continue
        by_key[merge_key] = row
    if duplicates:
        preview = "; ".join(duplicates[:10])
        suffix = " ..." if len(duplicates) > 10 else ""
        raise ValueError(f"汇总表同一个规则型号+单价存在多个保留 SKU，无法归并: {preview}{suffix}")
    return by_key


def find_latest_delivery_csv(sp_no: str, *, csv_dir: str | Path | None = None) -> Path | None:
    target = _clean_cell(sp_no).upper()
    directory = Path(DELIVERY_CSV_DIR if csv_dir is None else csv_dir)
    if not directory.is_dir():
        return None
    candidates = [path for path in directory.glob(f"{target}_*.csv") if path.is_file()]
    if not candidates:
        return None
    return max(candidates, key=lambda path: (path.stat().st_mtime, path.name))


def resolve_delivery_csv_path(sp_no: str, delivery_csv: str | Path | None = None) -> Path:
    if delivery_csv:
        path = Path(delivery_csv).expanduser()
        if not path.is_file():
            raise FileNotFoundError(f"找不到发货单 CSV: {path}")
        return path.resolve()
    path = find_latest_delivery_csv(sp_no)
    if path is None:
        raise FileNotFoundError(f"本地未找到发货单 CSV: {DELIVERY_CSV_DIR / f'{_clean_cell(sp_no).upper()}_*.csv'}")
    return path.resolve()


def resolve_consignment_excel_path(sp_no: str, consignment_excel: str | Path | None = None) -> Path:
    if consignment_excel:
        path = Path(consignment_excel).expanduser()
        if not path.is_file():
            raise FileNotFoundError(f"找不到装箱数据 Excel: {path}")
        return path.resolve()
    return Path(find_consignment_excel(sp_no)).resolve()


def _parse_decimal(value: Any, *, field_name: str, row_context: str) -> Decimal:
    text = _clean_cell(value)
    if not text:
        raise ValueError(f"{row_context} 缺少 {field_name}")
    try:
        return Decimal(text)
    except (InvalidOperation, TypeError, ValueError) as exc:
        raise ValueError(f"{row_context} 的 {field_name} 无法解析为数字: {value}") from exc


def _normalized_price_key(value: Any, *, row_context: str) -> Decimal:
    price = _parse_decimal(value, field_name="单价", row_context=row_context)
    return price.quantize(MERGE_PRICE_QUANTIZE, rounding=ROUND_HALF_UP)


def _decimal_sort_text(value: Decimal) -> str:
    if value == value.to_integral_value():
        return str(int(value))
    return format(value.normalize(), "f").rstrip("0").rstrip(".")


def _box_sort_key(box_no: str) -> tuple[int, str]:
    try:
        return 0, f"{int(Decimal(str(box_no))):08d}"
    except Exception:
        return 1, str(box_no)


def _parse_sku_quantity_item(raw_item: str, *, row_number: int) -> tuple[str, Decimal]:
    item = str(raw_item or "").strip()
    if not item:
        raise ValueError(f"第{row_number}行 {SKU_SHIP_QTY_COLUMN} 存在空项目")
    match = SKU_QTY_PATTERN.match(item)
    if not match:
        raise ValueError(f"第{row_number}行 {SKU_SHIP_QTY_COLUMN} 格式无法解析: {item}")
    sku = _clean_cell(match.group("sku"))
    if not sku:
        raise ValueError(f"第{row_number}行 {SKU_SHIP_QTY_COLUMN} 缺少 SKU: {item}")
    quantity = _parse_decimal(match.group("qty"), field_name="数量", row_context=f"第{row_number}行 {SKU_SHIP_QTY_COLUMN}")
    if quantity < 0:
        raise ValueError(f"第{row_number}行 {SKU_SHIP_QTY_COLUMN} 数量不能小于 0: {item}")
    return sku, quantity


def _read_delivery_rows(csv_path: str | Path) -> tuple[list[str], list[dict[str, str]]]:
    source_path = Path(csv_path).expanduser()
    if not source_path.is_file():
        raise FileNotFoundError(f"找不到发货单 CSV: {source_path}")
    last_error: Exception | None = None
    for encoding in ("utf-8-sig", "gb18030"):
        try:
            with source_path.open("r", encoding=encoding, newline="") as handle:
                reader = csv.DictReader(handle)
                headers = [_clean_cell(name) for name in list(reader.fieldnames or [])]
                rows = [{_clean_cell(key): _clean_cell(value) for key, value in row.items()} for row in reader]
                return headers, rows
        except UnicodeDecodeError as exc:
            last_error = exc
    raise RuntimeError(f"读取发货单 CSV 失败: {source_path}, error={last_error}") from last_error


def read_delivery_msku_components(csv_path: str | Path) -> OrderedDict[str, OrderedDict[str, Decimal]]:
    headers, rows = _read_delivery_rows(csv_path)
    missing = [column for column in (DELIVERY_MSKU_COLUMN, SKU_SHIP_QTY_COLUMN) if column not in headers]
    if missing:
        raise ValueError(f"发货单 CSV 缺少列: {', '.join(missing)}")

    components: OrderedDict[str, OrderedDict[str, Decimal]] = OrderedDict()
    for index, row in enumerate(rows, start=2):
        msku = _clean_cell(row.get(DELIVERY_MSKU_COLUMN))
        cell_value = _clean_cell(row.get(SKU_SHIP_QTY_COLUMN))
        if not cell_value:
            continue
        if not msku:
            raise ValueError(f"第{index}行 {SKU_SHIP_QTY_COLUMN} 有值但 MSKU 为空")
        msku_components = components.setdefault(msku, OrderedDict())
        for raw_item in ITEM_SPLIT_PATTERN.split(cell_value):
            item = str(raw_item or "").strip()
            if not item:
                continue
            sku, quantity = _parse_sku_quantity_item(item, row_number=index)
            msku_components[sku] = msku_components.get(sku, Decimal("0")) + quantity
    if not components:
        raise ValueError(f"发货单 CSV 未解析到有效 {DELIVERY_MSKU_COLUMN} + {SKU_SHIP_QTY_COLUMN}")
    return components


def _resolve_required_column(columns: list[str], aliases: tuple[str, ...] | str, *, label: str) -> str:
    alias_tuple = (aliases,) if isinstance(aliases, str) else aliases
    column = resolve_column(columns, alias_tuple)
    if not column:
        raise ValueError(f"装箱数据缺少列: {label}")
    return column


def _consistent_box_info(existing: ConsignmentBoxInfo, current: ConsignmentBoxInfo, *, row_number: int) -> None:
    if existing == current:
        return
    raise ValueError(
        f"装箱数据同一箱序号存在不同箱规: 箱序号={existing.box_no}, "
        f"row={row_number}, existing={existing}, current={current}"
    )


def read_consignment_msku_rows(excel_path: str | Path) -> list[ConsignmentMskuRow]:
    try:
        import pandas as pd
    except Exception as exc:
        raise RuntimeError("缺少 pandas 依赖，无法读取装箱数据 Excel") from exc

    source_path = Path(excel_path).expanduser()
    if not source_path.is_file():
        raise FileNotFoundError(f"找不到装箱数据 Excel: {source_path}")
    try:
        with pd.ExcelFile(source_path) as workbook:
            sheet_name = "FBA装箱任务" if "FBA装箱任务" in workbook.sheet_names else workbook.sheet_names[0]
            df = pd.read_excel(workbook, sheet_name=sheet_name, dtype=str)
    except Exception as exc:
        raise RuntimeError(f"读取装箱数据 Excel 失败: {source_path.name}, error={exc}") from exc
    if df.empty:
        raise ValueError(f"装箱数据没有有效数据: {source_path.name}")

    columns = [_clean_cell(column) for column in list(df.columns)]
    df.columns = columns
    box_col = _resolve_required_column(columns, CONSIGNMENT_BOX_ALIASES, label="箱序号")
    msku_col = _resolve_required_column(columns, CONSIGNMENT_MSKU_COLUMN, label=CONSIGNMENT_MSKU_COLUMN)
    quantity_col = _resolve_required_column(columns, CONSIGNMENT_QUANTITY_COLUMN, label=CONSIGNMENT_QUANTITY_COLUMN)
    length_col = _resolve_required_column(columns, CONSIGNMENT_LENGTH_ALIASES, label="长")
    width_col = _resolve_required_column(columns, CONSIGNMENT_WIDTH_ALIASES, label="宽")
    height_col = _resolve_required_column(columns, CONSIGNMENT_HEIGHT_ALIASES, label="高")
    weight_col = _resolve_required_column(columns, CONSIGNMENT_GROSS_WEIGHT_ALIASES, label="毛重")

    rows: list[ConsignmentMskuRow] = []
    box_info_by_no: dict[str, ConsignmentBoxInfo] = {}
    for index, row in df.iterrows():
        row_number = int(index) + 2
        box_no = _clean_cell(row.get(box_col))
        msku = _clean_cell(row.get(msku_col))
        quantity_text = _clean_cell(row.get(quantity_col))
        if not any((box_no, msku, quantity_text)):
            continue
        row_context = f"装箱数据第{row_number}行"
        if not box_no:
            raise ValueError(f"{row_context} 缺少箱序号")
        if not msku:
            raise ValueError(f"{row_context} 缺少 MSKU")
        quantity = _parse_decimal(quantity_text, field_name="装箱数量", row_context=row_context)
        if quantity <= 0:
            raise ValueError(f"{row_context} 装箱数量必须大于 0: {quantity_text}")
        box_info = ConsignmentBoxInfo(
            box_no=box_no,
            gross_weight=_clean_cell(row.get(weight_col)),
            length=_clean_cell(row.get(length_col)),
            width=_clean_cell(row.get(width_col)),
            height=_clean_cell(row.get(height_col)),
        )
        for field_name, value in (
            ("毛重", box_info.gross_weight),
            ("长", box_info.length),
            ("宽", box_info.width),
            ("高", box_info.height),
        ):
            if not value:
                raise ValueError(f"{row_context} 缺少 {field_name}")
        existing = box_info_by_no.get(box_no)
        if existing is not None:
            _consistent_box_info(existing, box_info, row_number=row_number)
        else:
            box_info_by_no[box_no] = box_info
        rows.append(ConsignmentMskuRow(row_number=row_number, box_info=box_info, msku=msku, quantity=quantity))
    if not rows:
        raise ValueError(f"装箱数据未解析到有效 MSKU 和装箱数量: {source_path.name}")
    return rows


def _decimal_to_quantity(value: Decimal, *, context: str) -> Decimal:
    if value != value.to_integral_value():
        raise ValueError(f"{context} 计算得到非整数库存 SKU 数量: {value}")
    return value


def build_invoice_box_rows(
    source_rows: list[InvoiceSourceRow],
    stock_sku_merge_infos: OrderedDict[str, StockSkuMergeInfo],
    delivery_components: OrderedDict[str, OrderedDict[str, Decimal]],
    consignment_rows: list[ConsignmentMskuRow],
) -> list[InvoiceBoxRow]:
    source_by_merge_key = _source_rows_by_merge_key(source_rows)
    consignment_totals: OrderedDict[str, Decimal] = OrderedDict()
    for row in consignment_rows:
        consignment_totals[row.msku] = consignment_totals.get(row.msku, Decimal("0")) + row.quantity

    missing_in_delivery = [msku for msku in consignment_totals if msku not in delivery_components]
    if missing_in_delivery:
        preview = ", ".join(missing_in_delivery[:10])
        suffix = " ..." if len(missing_in_delivery) > 10 else ""
        raise ValueError(f"装箱数据 MSKU 在发货单中不存在: {preview}{suffix}")
    missing_in_consignment = [msku for msku in delivery_components if msku not in consignment_totals]
    if missing_in_consignment:
        preview = ", ".join(missing_in_consignment[:10])
        suffix = " ..." if len(missing_in_consignment) > 10 else ""
        raise ValueError(f"发货单 MSKU 在装箱数据中不存在: {preview}{suffix}")

    component_ratios: dict[str, OrderedDict[str, Decimal]] = {}
    for msku, components in delivery_components.items():
        total_quantity = consignment_totals[msku]
        if total_quantity <= 0:
            raise ValueError(f"装箱数据 MSKU 总装箱数量必须大于 0: {msku}")
        ratios: OrderedDict[str, Decimal] = OrderedDict()
        for sku, quantity in components.items():
            ratios[sku] = quantity / total_quantity
        component_ratios[msku] = ratios

    aggregate: OrderedDict[tuple[str, tuple[str, Decimal]], dict[str, Any]] = OrderedDict()
    for consignment_row in consignment_rows:
        for sku, ratio in component_ratios[consignment_row.msku].items():
            quantity = _decimal_to_quantity(
                consignment_row.quantity * ratio,
                context=f"箱序号={consignment_row.box_info.box_no}, MSKU={consignment_row.msku}, SKU={sku}",
            )
            if quantity == 0:
                continue
            sku_key = normalize_sku_key(sku)
            merge_info = stock_sku_merge_infos.get(sku_key)
            if merge_info is None:
                raise ValueError(f"拆分得到的库存 SKU 不在财务合并明细表中: SKU={sku}, MSKU={consignment_row.msku}")
            source_row = source_by_merge_key.get(merge_info.merge_key)
            if source_row is None:
                raise ValueError(
                    "拆分得到的库存 SKU 合并键在汇总表中不存在: "
                    f"SKU={sku}, MSKU={consignment_row.msku}, {_merge_key_text(merge_info.merge_key)}"
                )
            aggregate_key = (consignment_row.box_info.box_no, merge_info.merge_key)
            if aggregate_key not in aggregate:
                aggregate[aggregate_key] = {
                    "source": source_row,
                    "box_info": consignment_row.box_info,
                    "quantity": Decimal("0"),
                }
            aggregate[aggregate_key]["quantity"] += quantity

    invoice_rows = [
        InvoiceBoxRow(
            source=value["source"],
            box_info=value["box_info"],
            quantity=value["quantity"],
        )
        for value in aggregate.values()
    ]
    if not invoice_rows:
        raise ValueError("按装箱数据拆分后未生成发票明细行")

    actual_totals: OrderedDict[tuple[str, Decimal], Decimal] = OrderedDict()
    for (_box_no, merge_key), value in aggregate.items():
        actual_totals[merge_key] = actual_totals.get(merge_key, Decimal("0")) + value["quantity"]

    expected_totals: OrderedDict[tuple[str, Decimal], Decimal] = OrderedDict()
    for source_row in source_rows:
        merge_key = _merge_key_for_source_row(source_row)
        expected_totals[merge_key] = expected_totals.get(merge_key, Decimal("0")) + _parse_decimal(
            source_row.quantity,
            field_name="发货量",
            row_context=f"备货单第{source_row.row_number}行 SKU={source_row.sku}",
        )

    mismatches: list[str] = []
    for merge_key, expected in expected_totals.items():
        actual = actual_totals.get(merge_key, Decimal("0"))
        if actual != expected:
            source_row = source_by_merge_key[merge_key]
            mismatches.append(
                f"{source_row.sku}({_merge_key_text(merge_key)}): "
                f"expected={_decimal_sort_text(expected)}, actual={_decimal_sort_text(actual)}"
            )
    extra_keys = [merge_key for merge_key in actual_totals if merge_key not in expected_totals]
    for merge_key in extra_keys:
        mismatches.append(f"{_merge_key_text(merge_key)}: expected=0, actual={_decimal_sort_text(actual_totals[merge_key])}")
    if mismatches:
        preview = "; ".join(mismatches[:10])
        suffix = " ..." if len(mismatches) > 10 else ""
        raise ValueError(f"拆分归并后库存SKU数量与汇总表不一致: {preview}{suffix}")

    return sorted(invoice_rows, key=lambda row: (_box_sort_key(row.box_info.box_no), row.source.row_number))


def translate_commodity_name(row: InvoiceSourceRow) -> str:
    name = row.commodity_name
    if "编织表带" in name:
        return "Braided Watch Band"
    if "表带" in name:
        return "Watch Band"
    if "表壳" in name:
        return "Watch Case"
    if "包装盒" in name:
        return "Packaging Box"
    if "手表保护套" in name:
        return "Watch Protective Case"
    return ""


def translated_material(material: str) -> str:
    material_text = _clean_cell(material)
    if not material_text:
        return ""
    english = MATERIAL_TRANSLATIONS.get(material_text)
    if not english:
        return ""
    return f"{material_text}/{english}"


def usage_for(row: InvoiceSourceRow) -> str:
    name = row.commodity_name
    if "表带" in name:
        return "装饰/decorate"
    if "表壳" in name:
        return "装饰/decorate"
    if "手表保护套" in name:
        return "保护手表用/Used for protecting watches"
    if "包装盒" in name:
        return "装表带表壳/Watch strap and case"
    return ""


def _decimal_to_cell_value(value: Decimal) -> int | float | str:
    if value == value.to_integral_value():
        return int(value)
    text = format(value.normalize(), "f").rstrip("0").rstrip(".")
    try:
        return float(text)
    except ValueError:
        return text


def declared_price_for(row: InvoiceSourceRow, material: str) -> int | float | str:
    material_text = _clean_cell(material)
    unit_price: Decimal | None = None
    if "表带" in row.commodity_name:
        if material_text == "硅胶":
            unit_price = Decimal("0.35")
        elif material_text == "尼龙":
            unit_price = Decimal("0.5")
        elif material_text == "皮革":
            unit_price = Decimal("0.5")
        elif material_text in {"金属", "贱金属"}:
            unit_price = Decimal("1")
    elif "表壳" in row.commodity_name:
        unit_price = Decimal("0.35")
    elif "包装盒" in row.commodity_name:
        unit_price = Decimal("0.32")
    elif "手表保护套" in row.commodity_name:
        unit_price = Decimal("0.35")
    if unit_price is not None:
        return _decimal_to_cell_value(unit_price)
    return UNKNOWN_DECLARED_PRICE_TEXT


def _find_invoice_template_header_row(worksheet: Any) -> int:
    expected = list(INVOICE_TEMPLATE_HEADERS)
    for row_index in range(1, worksheet.max_row + 1):
        actual = [
            _clean_cell(worksheet.cell(row=row_index, column=column_index).value)
            for column_index in range(1, len(expected) + 1)
        ]
        if actual == expected:
            return row_index
    raise ValueError(f"{INVOICE_TEMPLATE_SHEET} sheet 缺少表头: {expected}")


def _copy_row_style(worksheet: Any, *, source_row: int, target_row: int) -> None:
    if source_row == target_row:
        return
    worksheet.row_dimensions[target_row].height = worksheet.row_dimensions[source_row].height
    for column_index in range(1, len(INVOICE_TEMPLATE_HEADERS) + 1):
        source_cell = worksheet.cell(row=source_row, column=column_index)
        target_cell = worksheet.cell(row=target_row, column=column_index)
        if source_cell.has_style:
            target_cell._style = copy.copy(source_cell._style)
        if source_cell.number_format:
            target_cell.number_format = source_cell.number_format
        if source_cell.alignment:
            target_cell.alignment = copy.copy(source_cell.alignment)
        if source_cell.font:
            target_cell.font = copy.copy(source_cell.font)
        if source_cell.fill:
            target_cell.fill = copy.copy(source_cell.fill)
        if source_cell.border:
            target_cell.border = copy.copy(source_cell.border)


def _clear_data_rows(worksheet: Any, *, header_row: int) -> None:
    for row_index in range(header_row + 1, worksheet.max_row + 1):
        for column_index in range(1, len(INVOICE_TEMPLATE_HEADERS) + 1):
            worksheet.cell(row=row_index, column=column_index).value = None


def _image_bytes(image: Any) -> bytes:
    try:
        return image._data()
    except Exception as exc:
        raise RuntimeError(f"读取库存SKU图片失败: {exc}") from exc


def load_stock_sku_images(xlsx_paths: list[str] | tuple[str, ...]) -> dict[str, bytes]:
    images_by_key: dict[str, bytes] = {}
    for raw_path in xlsx_paths:
        source_path = Path(raw_path).expanduser()
        if not source_path.is_file():
            raise FileNotFoundError(f"找不到库存SKU导出xlsx: {source_path}")
        workbook = _load_workbook(source_path, data_only=True)
        try:
            worksheet = workbook.worksheets[0]
            headers = [_clean_cell(worksheet.cell(row=1, column=column_index).value) for column_index in range(1, worksheet.max_column + 1)]
            if STOCK_SKU_COLUMN not in headers:
                raise RuntimeError(f"库存SKU导出xlsx缺少列: {STOCK_SKU_COLUMN}")
            if STOCK_SKU_IMAGE_COLUMN not in headers:
                raise RuntimeError(f"库存SKU导出xlsx缺少列: {STOCK_SKU_IMAGE_COLUMN}")
            sku_col = headers.index(STOCK_SKU_COLUMN) + 1
            image_col = headers.index(STOCK_SKU_IMAGE_COLUMN) + 1
            for image in list(getattr(worksheet, "_images", []) or []):
                marker = getattr(getattr(image, "anchor", None), "_from", None)
                if marker is None:
                    continue
                image_row = int(marker.row) + 1
                image_column = int(marker.col) + 1
                if image_column != image_col:
                    continue
                sku = _clean_cell(worksheet.cell(row=image_row, column=sku_col).value)
                key = normalize_sku_key(sku)
                if key and key not in images_by_key:
                    images_by_key[key] = _image_bytes(image)
        finally:
            workbook.close()
    return images_by_key


def _add_image_to_cell(worksheet: Any, *, image_bytes: bytes, row: int, column: int) -> None:
    try:
        from openpyxl.drawing.image import Image
        from openpyxl.utils import get_column_letter
    except Exception as exc:
        raise RuntimeError("缺少 openpyxl 图片依赖，无法写入产品图片") from exc

    image = Image(BytesIO(image_bytes))
    if image.width and image.height:
        scale = min(IMAGE_MAX_WIDTH / image.width, IMAGE_MAX_HEIGHT / image.height, 1)
        image.width = int(image.width * scale)
        image.height = int(image.height * scale)
    worksheet.row_dimensions[row].height = max(float(worksheet.row_dimensions[row].height or 0), IMAGE_ROW_HEIGHT)
    column_letter = get_column_letter(column)
    worksheet.column_dimensions[column_letter].width = max(
        float(worksheet.column_dimensions[column_letter].width or 0),
        IMAGE_COLUMN_WIDTH,
    )
    worksheet.add_image(image, f"{column_letter}{row}")


def write_invoice_template(
    rows: list[InvoiceBoxRow],
    *,
    sp_no: str,
    destination_country: str,
    stock_sku_xlsx_paths: list[str],
    template_path: str | Path | None = None,
    output_dir: str | Path | None = None,
) -> dict[str, Any]:
    source_template = Path(DEFAULT_TEMPLATE_PATH if template_path is None else template_path).expanduser()
    if not source_template.is_file():
        raise FileNotFoundError(f"找不到发票模板: {source_template}")
    target_dir = Path(DEFAULT_OUTPUT_DIR if output_dir is None else output_dir)
    target_dir.mkdir(parents=True, exist_ok=True)
    output_path = target_dir / f"{sp_no}_invoice_Template.xlsx"

    workbook = _load_workbook(source_template)
    try:
        if INVOICE_TEMPLATE_SHEET not in workbook.sheetnames:
            raise ValueError(f"发票模板缺少 sheet: {INVOICE_TEMPLATE_SHEET}")
        worksheet = workbook[INVOICE_TEMPLATE_SHEET]
        header_row = _find_invoice_template_header_row(worksheet)
        first_data_row = header_row + 1
        header_to_col = {
            _clean_cell(worksheet.cell(row=header_row, column=column_index).value): column_index
            for column_index in range(1, len(INVOICE_TEMPLATE_HEADERS) + 1)
        }
        _clear_data_rows(worksheet, header_row=header_row)
        images_by_key = load_stock_sku_images(stock_sku_xlsx_paths)

        notice: list[str] = []
        image_matched_count = 0
        image_missing_count = 0
        for offset, invoice_row in enumerate(rows):
            row = invoice_row.source
            target_row = first_data_row + offset
            _copy_row_style(worksheet, source_row=first_data_row, target_row=target_row)
            classification = classify_declaration(row.to_declaration_row())
            material = classification.declaration_element
            hs_code = classification.hs_code
            if not material or not hs_code:
                notice.append(f"第{row.row_number}行未匹配申报规则: SKU={row.sku}, 商品名称={row.commodity_name}, 品名={row.source_name}")
            english_name = translate_commodity_name(row)
            if not english_name:
                notice.append(f"第{row.row_number}行缺少英文品名规则: SKU={row.sku}, 商品名称={row.commodity_name}")
            declared_price = declared_price_for(row, material)
            if declared_price == UNKNOWN_DECLARED_PRICE_TEXT:
                notice.append(f"第{row.row_number}行没有该材质的计算价格方式: SKU={row.sku}, 产品材质={material or ''}")
            material_value = translated_material(material)
            if material and not material_value:
                notice.append(f"第{row.row_number}行缺少产品材质英文映射: SKU={row.sku}, 产品材质={material}")
            usage = usage_for(row)
            if not usage:
                notice.append(f"第{row.row_number}行缺少产品用途规则: SKU={row.sku}, 商品名称={row.commodity_name}")

            values = {
                "货箱编号*": invoice_row.box_info.box_no,
                "单件货箱重量(KG)*": invoice_row.box_info.gross_weight,
                "货箱长度(CM)*": invoice_row.box_info.length,
                "货箱宽度(CM)*": invoice_row.box_info.width,
                "货箱高度(CM)*": invoice_row.box_info.height,
                "产品英文品名*": english_name,
                "产品中文品名*": row.commodity_name,
                "产品申报单价*": declared_price,
                "单箱产品申报数量*": _decimal_to_cell_value(invoice_row.quantity),
                "单位*": row.unit,
                "产品材质*": material_value,
                "产品海关编码*": hs_code,
                "产品用途*": usage,
                "产品品牌*": "无",
                "品牌类型*": "无",
                "产品型号*": row.sku,
            }
            for header, value in values.items():
                worksheet.cell(row=target_row, column=header_to_col[header], value=value)

            image_key = normalize_sku_key(row.sku)
            image_data = images_by_key.get(image_key)
            if image_data:
                _add_image_to_cell(
                    worksheet,
                    image_bytes=image_data,
                    row=target_row,
                    column=header_to_col["产品图片*"],
                )
                image_matched_count += 1
            else:
                image_missing_count += 1
                notice.append(f"第{row.row_number}行缺少产品图片: SKU={row.sku}")

        workbook.save(output_path)
    finally:
        workbook.close()

    return {
        "success": True,
        "sp_no": sp_no,
        "destination_country": destination_country,
        "output_xlsx": str(output_path),
        "row_count": len(rows),
        "stock_sku_xlsx_paths": list(stock_sku_xlsx_paths),
        "image_matched_count": image_matched_count,
        "image_missing_count": image_missing_count,
        "notice": notice,
        "source": SOURCE,
    }


async def fill_invoice_template(
    input_xlsx: str | Path,
    *,
    template_path: str | Path | None = None,
    output_dir: str | Path | None = None,
    stock_sku_output_dir: str | Path | None = None,
    delivery_csv: str | Path | None = None,
    consignment_excel: str | Path | None = None,
) -> dict[str, Any]:
    input_path = Path(input_xlsx).expanduser()
    sp_no = extract_sp_no_from_filename(input_path)
    destination_country = extract_destination_country_from_filename(input_path)
    source_rows = read_invoice_source_rows(input_path)
    stock_sku_merge_infos = read_stock_sku_merge_infos(input_path)
    source_rows, inferred_model_notices = infer_missing_summary_models(source_rows, stock_sku_merge_infos)
    delivery_csv_path = resolve_delivery_csv_path(sp_no, delivery_csv)
    consignment_excel_path = resolve_consignment_excel_path(sp_no, consignment_excel)
    delivery_components = read_delivery_msku_components(delivery_csv_path)
    consignment_rows = read_consignment_msku_rows(consignment_excel_path)
    invoice_rows = build_invoice_box_rows(source_rows, stock_sku_merge_infos, delivery_components, consignment_rows)
    skus = unique_source_skus(source_rows)
    stock_result = await export_stock_sku_names(
        skus,
        delivery_no=f"{sp_no}_invoice",
        output_dir=STOCK_SKU_OUTPUT_DIR if stock_sku_output_dir is None else stock_sku_output_dir,
    )
    stock_sku_xlsx_paths = list(getattr(stock_result, "xlsx_paths", []) or [])
    payload = write_invoice_template(
        invoice_rows,
        sp_no=sp_no,
        destination_country=destination_country,
        stock_sku_xlsx_paths=stock_sku_xlsx_paths,
        template_path=template_path,
        output_dir=output_dir,
    )
    payload["notice"] = inferred_model_notices + list(payload.get("notice", []))
    payload["input_xlsx"] = str(input_path)
    payload["delivery_csv_path"] = str(delivery_csv_path)
    payload["consignment_excel_path"] = str(consignment_excel_path)
    payload["box_count"] = len({row.box_info.box_no for row in invoice_rows})
    payload["source_row_count"] = len(source_rows)
    payload["invoice_row_count"] = len(invoice_rows)
    payload["merge_group_count"] = len({_merge_key_for_source_row(row) for row in source_rows})
    payload["merged_sku_count"] = max(0, len(stock_sku_merge_infos) - payload["merge_group_count"])
    return payload


def build_parser() -> argparse.ArgumentParser:
    parser = JsonArgumentParser(
        prog="python -m services.agent_cli.mabang.fill_invoice_template"
    )
    parser.add_argument("--input-xlsx", default="")
    parser.add_argument("--delivery-csv", default="")
    parser.add_argument("--consignment-excel", default="")
    return parser


async def _run_async(args: argparse.Namespace) -> dict[str, Any]:
    input_xlsx = str(getattr(args, "input_xlsx", "") or "").strip()
    if not input_xlsx:
        raise ValueError("input_xlsx 不能为空")
    return await fill_invoice_template(
        input_xlsx,
        delivery_csv=str(getattr(args, "delivery_csv", "") or "").strip() or None,
        consignment_excel=str(getattr(args, "consignment_excel", "") or "").strip() or None,
    )


def main(argv: list[str] | None = None) -> int:
    configure_utf8_stdio()
    try:
        args = build_parser().parse_args(argv)
        payload = asyncio.run(_run_async(args))
    except Exception as exc:
        payload = {
            "success": False,
            "exception": _exception_text(exc),
        }
    finally:
        try:
            asyncio.run(close_all_network_clients())
        except Exception:
            pass

    _write_json(payload)
    return 0 if bool(payload.get("success")) else 1


if __name__ == "__main__":
    raise SystemExit(main())
