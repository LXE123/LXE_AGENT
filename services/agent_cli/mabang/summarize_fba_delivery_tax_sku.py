from __future__ import annotations

import argparse
import asyncio
import csv
import json
import re
import sys
from collections import OrderedDict
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

from services.agent_cli._shared.json_output import configure_utf8_stdio
from services.mabang.stock_sku_export import export_stock_sku_names
from services.mabang.amazon.fba import download_fba_delivery_csv
from services.mabang.amazon.fba.batch_delivery import normalize_delivery_no
from shared.infra.net import close_all_network_clients

DELIVERY_CSV_DIR = Path("artifacts") / "mabang_fba_delivery"
OUTPUT_DIR = Path("artifacts") / "mabang_fba_tax_summary"
STOCK_SKU_OUTPUT_DIR = Path("artifacts") / "mabang_stock_sku"
EXPORT_TAX_PRODUCTS_PATH = Path("data") / "export_tax" / "export_tax_products.xlsx"
EXPORT_TAX_PRODUCTS_SHEET = "Sheet1"
SKU_SHIP_QTY_COLUMN = "SKU发货量"
TAX_PRODUCT_SKU_COLUMN = "sku"
TAX_PRODUCT_NAME_COLUMN = "产品名称"
MATCHED_SHEET_NAME = "可出口退税"
UNMATCHED_SHEET_NAME = "不可出口退税"
MATCHED_COLUMNS = ("SKU", "产品名称", "发货量")
UNMATCHED_COLUMNS = ("SKU", "产品名称", "发货量")
SOURCE = "fba_delivery_tax_summary"
ITEM_SPLIT_PATTERN = re.compile(r"[，,\r\n;；]+")
SKU_QTY_PATTERN = re.compile(r"^\s*(?P<sku>.+?)\s*(?:×|x|X|\*)\s*(?P<qty>\d+(?:\.\d+)?)\s*$")
WHITESPACE_PATTERN = re.compile(r"\s+")


class JsonArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise ValueError(str(message or "").strip() or "参数解析失败")


def _write_json(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(dict(payload or {}), ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _exception_text(exc: Exception) -> str:
    message = str(exc or "").strip()
    return message or exc.__class__.__name__


def _require_delivery_no(value: Any) -> str:
    delivery_no = normalize_delivery_no(value)
    if not delivery_no:
        raise ValueError("delivery_no 不能为空")
    if not delivery_no.startswith("SP"):
        raise ValueError(f"delivery_no 格式无效: {delivery_no}")
    return delivery_no


def _decimal_to_cell_value(value: Decimal) -> int | float | str:
    if value == value.to_integral_value():
        return int(value)
    normalized = value.normalize()
    text = format(normalized, "f").rstrip("0").rstrip(".")
    try:
        return float(text)
    except ValueError:
        return text


def _clean_cell(value: Any) -> str:
    text = str(value or "").strip()
    if text.lower() == "nan":
        return ""
    return text


def _sku_match_key(value: Any) -> str:
    return WHITESPACE_PATTERN.sub("", _clean_cell(value))


def find_latest_delivery_csv(delivery_no: str, *, csv_dir: str | Path | None = None) -> Path | None:
    target = _require_delivery_no(delivery_no)
    directory = Path(DELIVERY_CSV_DIR if csv_dir is None else csv_dir)
    if not directory.is_dir():
        return None
    candidates = [
        path
        for path in directory.glob(f"{target}_*.csv")
        if path.is_file()
    ]
    if not candidates:
        return None
    return max(candidates, key=lambda path: (path.stat().st_mtime, path.name))


async def resolve_delivery_csv(delivery_no: str, *, csv_dir: str | Path | None = None) -> Path:
    local_path = find_latest_delivery_csv(delivery_no, csv_dir=csv_dir)
    if local_path is not None:
        return local_path

    result = await download_fba_delivery_csv(delivery_no)
    csv_path = Path(str(result.csv_path or "")).expanduser()
    if not csv_path.is_file():
        raise RuntimeError(f"下载完成但找不到发货单 CSV: {csv_path}")
    return csv_path


def _read_delivery_rows(csv_path: str | Path) -> tuple[list[str], list[dict[str, str]]]:
    source_path = Path(csv_path).expanduser()
    if not source_path.is_file():
        raise RuntimeError(f"找不到发货单 CSV: {source_path}")
    with source_path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        headers = [str(name or "").strip() for name in list(reader.fieldnames or [])]
        rows = [{str(key or "").strip(): str(value or "").strip() for key, value in row.items()} for row in reader]
    return headers, rows


def _parse_sku_quantity_item(raw_item: str, *, row_number: int) -> tuple[str, Decimal]:
    item = str(raw_item or "").strip()
    if not item:
        raise RuntimeError(f"第{row_number}行 SKU发货量 存在空项目")
    match = SKU_QTY_PATTERN.match(item)
    if not match:
        raise RuntimeError(f"第{row_number}行 SKU发货量 格式无法解析: {item}")
    sku = str(match.group("sku") or "").strip()
    if not sku:
        raise RuntimeError(f"第{row_number}行 SKU发货量 缺少 SKU: {item}")
    try:
        quantity = Decimal(str(match.group("qty") or "").strip())
    except (InvalidOperation, ValueError) as exc:
        raise RuntimeError(f"第{row_number}行 SKU发货量 数量无效: {item}") from exc
    return sku, quantity


def summarize_tax_sku_quantities(csv_path: str | Path) -> OrderedDict[str, Decimal]:
    headers, rows = _read_delivery_rows(csv_path)
    if SKU_SHIP_QTY_COLUMN not in headers:
        raise RuntimeError(f"发货单 CSV 缺少列: {SKU_SHIP_QTY_COLUMN}")

    summary: OrderedDict[str, Decimal] = OrderedDict()
    for index, row in enumerate(rows, start=2):
        cell_value = str(row.get(SKU_SHIP_QTY_COLUMN) or "").strip()
        if not cell_value:
            continue
        for raw_item in ITEM_SPLIT_PATTERN.split(cell_value):
            item = str(raw_item or "").strip()
            if not item:
                continue
            sku, quantity = _parse_sku_quantity_item(item, row_number=index)
            if sku not in summary:
                summary[sku] = Decimal("0")
            summary[sku] += quantity

    if not summary:
        raise RuntimeError(f"发货单 CSV 未解析到有效 {SKU_SHIP_QTY_COLUMN}")
    return OrderedDict(sorted(summary.items(), key=lambda item: item[0]))


def load_export_tax_products(
    products_path: str | Path | None = None,
) -> OrderedDict[str, dict[str, str]]:
    source_path = Path(EXPORT_TAX_PRODUCTS_PATH if products_path is None else products_path)
    if not source_path.is_file():
        raise RuntimeError(f"找不到出口退税产品表: {source_path}")

    try:
        import pandas as pd
    except Exception as exc:
        raise RuntimeError("缺少 pandas 依赖，无法读取出口退税产品表") from exc

    try:
        df = pd.read_excel(source_path, sheet_name=EXPORT_TAX_PRODUCTS_SHEET, dtype=str)
    except Exception as exc:
        raise RuntimeError(f"读取出口退税产品表失败: {source_path}, sheet={EXPORT_TAX_PRODUCTS_SHEET}, error={exc}") from exc

    columns = [str(column or "").strip() for column in list(df.columns)]
    df.columns = columns
    missing_columns = [
        column
        for column in (TAX_PRODUCT_SKU_COLUMN, TAX_PRODUCT_NAME_COLUMN)
        if column not in columns
    ]
    if missing_columns:
        raise RuntimeError(f"出口退税产品表缺少列: {', '.join(missing_columns)}")

    products: OrderedDict[str, dict[str, str]] = OrderedDict()
    for row in df.to_dict(orient="records"):
        sku = _clean_cell(row.get(TAX_PRODUCT_SKU_COLUMN))
        key = _sku_match_key(sku)
        if not key or key in products:
            continue
        products[key] = {
            "sku": sku,
            "product_name": _clean_cell(row.get(TAX_PRODUCT_NAME_COLUMN)),
        }
    if not products:
        raise RuntimeError("出口退税产品表没有有效 sku")
    return products


def split_tax_sku_summary(
    summary: OrderedDict[str, Decimal],
    products: OrderedDict[str, dict[str, str]],
) -> tuple[list[list[Any]], list[list[Any]]]:
    matched_rows: list[list[Any]] = []
    unmatched_rows: list[list[Any]] = []
    for sku, quantity in summary.items():
        key = _sku_match_key(sku)
        product = products.get(key)
        quantity_value = _decimal_to_cell_value(quantity)
        if product is None:
            unmatched_rows.append([sku, "", quantity_value])
            continue
        matched_rows.append([
            str(product.get("sku") or sku).strip(),
            str(product.get("product_name") or "").strip(),
            quantity_value,
        ])
    return matched_rows, unmatched_rows


def fill_unmatched_product_names(
    unmatched_rows: list[list[Any]],
    stock_names_by_key: dict[str, str],
) -> tuple[list[list[Any]], int, int]:
    filled_rows: list[list[Any]] = []
    matched_count = 0
    missing_count = 0
    for row in unmatched_rows:
        sku = str(row[0] if row else "").strip()
        quantity = row[2] if len(row) >= 3 else (row[1] if len(row) >= 2 else "")
        product_name = str(stock_names_by_key.get(_sku_match_key(sku)) or "").strip()
        if product_name:
            matched_count += 1
        else:
            missing_count += 1
        filled_rows.append([sku, product_name, quantity])
    return filled_rows, matched_count, missing_count


def write_summary_xlsx(
    matched_rows: list[list[Any]],
    unmatched_rows: list[list[Any]],
    *,
    delivery_no: str,
    output_dir: str | Path | None = None,
) -> Path:
    target = _require_delivery_no(delivery_no)
    directory = Path(OUTPUT_DIR if output_dir is None else output_dir)
    directory.mkdir(parents=True, exist_ok=True)
    output_path = directory / f"{target}_tax_summary.xlsx"

    try:
        from openpyxl import Workbook
    except Exception as exc:
        raise RuntimeError("缺少 openpyxl 依赖，无法写入 xlsx") from exc

    workbook = Workbook()
    worksheet = workbook.active
    worksheet.title = MATCHED_SHEET_NAME
    worksheet.append(list(MATCHED_COLUMNS))
    for row in matched_rows:
        worksheet.append(row)

    unmatched_sheet = workbook.create_sheet(UNMATCHED_SHEET_NAME)
    unmatched_sheet.append(list(UNMATCHED_COLUMNS))
    for row in unmatched_rows:
        unmatched_sheet.append(row)

    workbook.save(output_path)
    return output_path


async def summarize_delivery_tax_sku(
    delivery_no: str,
    *,
    csv_dir: str | Path | None = None,
    output_dir: str | Path | None = None,
    products_path: str | Path | None = None,
    stock_sku_output_dir: str | Path | None = None,
) -> dict[str, Any]:
    target = _require_delivery_no(delivery_no)
    csv_path = await resolve_delivery_csv(target, csv_dir=csv_dir)
    summary = summarize_tax_sku_quantities(csv_path)
    products = load_export_tax_products(products_path=products_path)
    matched_rows, unmatched_rows = split_tax_sku_summary(summary, products)
    stock_sku_xlsx_paths: list[str] = []
    stock_name_matched_count = 0
    stock_name_missing_count = 0
    if unmatched_rows:
        stock_result = await export_stock_sku_names(
            [str(row[0] or "").strip() for row in unmatched_rows],
            delivery_no=target,
            output_dir=STOCK_SKU_OUTPUT_DIR if stock_sku_output_dir is None else stock_sku_output_dir,
        )
        stock_sku_xlsx_paths = list(getattr(stock_result, "xlsx_paths", []) or [])
        stock_names_by_key = dict(getattr(stock_result, "names_by_key", {}) or {})
        unmatched_rows, stock_name_matched_count, stock_name_missing_count = fill_unmatched_product_names(
            unmatched_rows,
            stock_names_by_key,
        )
    xlsx_path = write_summary_xlsx(
        matched_rows,
        unmatched_rows,
        delivery_no=target,
        output_dir=output_dir,
    )
    return {
        "success": True,
        "delivery_no": target,
        "csv_path": str(csv_path),
        "xlsx_path": str(xlsx_path),
        "sku_count": len(summary),
        "matched_sku_count": len(matched_rows),
        "unmatched_sku_count": len(unmatched_rows),
        "stock_sku_xlsx_paths": stock_sku_xlsx_paths,
        "stock_name_matched_count": stock_name_matched_count,
        "stock_name_missing_count": stock_name_missing_count,
        "source": SOURCE,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = JsonArgumentParser(
        prog="python -m services.agent_cli.mabang.summarize_fba_delivery_tax_sku"
    )
    parser.add_argument("--delivery-no", default="")
    return parser


async def _run_async(args: argparse.Namespace) -> dict[str, Any]:
    delivery_no = _require_delivery_no(getattr(args, "delivery_no", ""))
    return await summarize_delivery_tax_sku(delivery_no)


def main(argv: list[str] | None = None) -> int:
    configure_utf8_stdio()
    delivery_no = ""
    try:
        args = build_parser().parse_args(argv)
        delivery_no = normalize_delivery_no(getattr(args, "delivery_no", ""))
        payload = asyncio.run(_run_async(args))
    except Exception as exc:
        payload = {
            "success": False,
            "delivery_no": delivery_no,
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
