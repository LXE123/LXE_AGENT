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
from services.mabang.amazon.fba.batch_delivery import normalize_delivery_no
from services.mabang.stock_sku_export import export_stock_sku_names
from shared.infra.net import close_all_network_clients

DELIVERY_CSV_DIR = Path("artifacts") / "mabang_fba_delivery"
STOCK_SKU_OUTPUT_DIR = Path("artifacts") / "mabang_stock_sku"
SKU_SHIP_QTY_COLUMN = "SKU发货量"
SOURCE = "mabang_stock_sku_download"
ITEM_SPLIT_PATTERN = re.compile(r"[，,\r\n;；]+")
SKU_QTY_PATTERN = re.compile(r"^\s*(?P<sku>.+?)\s*(?:×|x|X|\*)\s*(?P<qty>\d+(?:\.\d+)?)\s*$")


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


def _clean_cell(value: Any) -> str:
    text = str(value or "").strip()
    if text.lower() == "nan":
        return ""
    return text


def _parse_sku_quantity_item(raw_item: str, *, row_number: int) -> str:
    item = str(raw_item or "").strip()
    if not item:
        raise RuntimeError(f"第{row_number}行 {SKU_SHIP_QTY_COLUMN} 存在空项目")
    match = SKU_QTY_PATTERN.match(item)
    if not match:
        raise RuntimeError(f"第{row_number}行 {SKU_SHIP_QTY_COLUMN} 格式无法解析: {item}")
    sku = str(match.group("sku") or "").strip()
    if not sku:
        raise RuntimeError(f"第{row_number}行 {SKU_SHIP_QTY_COLUMN} 缺少 SKU: {item}")
    try:
        Decimal(str(match.group("qty") or "").strip())
    except (InvalidOperation, ValueError) as exc:
        raise RuntimeError(f"第{row_number}行 {SKU_SHIP_QTY_COLUMN} 数量无效: {item}") from exc
    return sku


def find_latest_delivery_csv(delivery_no: str, *, csv_dir: str | Path | None = None) -> Path | None:
    target = _require_delivery_no(delivery_no)
    directory = Path(DELIVERY_CSV_DIR if csv_dir is None else csv_dir)
    if not directory.is_dir():
        return None
    candidates = [path for path in directory.glob(f"{target}_*.csv") if path.is_file()]
    if not candidates:
        return None
    return max(candidates, key=lambda path: (path.stat().st_mtime, path.name))


def require_local_delivery_csv(delivery_no: str, *, csv_dir: str | Path | None = None) -> Path:
    target = _require_delivery_no(delivery_no)
    csv_path = find_latest_delivery_csv(target, csv_dir=csv_dir)
    if csv_path is None:
        directory = Path(DELIVERY_CSV_DIR if csv_dir is None else csv_dir)
        raise FileNotFoundError(f"本地未找到发货单 CSV: {directory / f'{target}_*.csv'}")
    return csv_path


def extract_stock_skus_from_delivery_csv(csv_path: str | Path) -> list[str]:
    source_path = Path(csv_path).expanduser()
    if not source_path.is_file():
        raise FileNotFoundError(f"找不到发货单 CSV: {source_path}")

    last_error: Exception | None = None
    for encoding in ("utf-8-sig", "gb18030"):
        try:
            with source_path.open("r", encoding=encoding, newline="") as handle:
                reader = csv.DictReader(handle)
                headers = [_clean_cell(name) for name in list(reader.fieldnames or [])]
                if SKU_SHIP_QTY_COLUMN not in headers:
                    raise RuntimeError(f"发货单 CSV 缺少列: {SKU_SHIP_QTY_COLUMN}")

                skus: OrderedDict[str, str] = OrderedDict()
                for row_number, row in enumerate(reader, start=2):
                    clean_row = {_clean_cell(key): _clean_cell(value) for key, value in row.items()}
                    cell_value = _clean_cell(clean_row.get(SKU_SHIP_QTY_COLUMN))
                    if not cell_value:
                        continue
                    for raw_item in ITEM_SPLIT_PATTERN.split(cell_value):
                        item = str(raw_item or "").strip()
                        if not item:
                            continue
                        sku = _parse_sku_quantity_item(item, row_number=row_number)
                        skus.setdefault(sku, sku)
                if not skus:
                    raise RuntimeError(f"发货单 CSV 未解析到有效 {SKU_SHIP_QTY_COLUMN}")
                return list(skus.values())
        except UnicodeDecodeError as exc:
            last_error = exc

    if last_error is not None:
        raise RuntimeError(f"读取发货单 CSV 失败: {source_path}, error={last_error}") from last_error
    raise RuntimeError(f"读取发货单 CSV 失败: {source_path}")


async def download_stock_sku_excel(
    delivery_no: str,
    *,
    csv_dir: str | Path | None = None,
    output_dir: str | Path | None = None,
) -> dict[str, Any]:
    target = _require_delivery_no(delivery_no)
    csv_path = require_local_delivery_csv(target, csv_dir=csv_dir)
    skus = extract_stock_skus_from_delivery_csv(csv_path)
    result = await export_stock_sku_names(
        skus,
        delivery_no=target,
        output_dir=STOCK_SKU_OUTPUT_DIR if output_dir is None else output_dir,
    )
    xlsx_paths = list(getattr(result, "xlsx_paths", []) or [])
    return {
        "success": True,
        "delivery_no": target,
        "delivery_csv_path": str(csv_path),
        "sku_count": len(skus),
        "source_column": SKU_SHIP_QTY_COLUMN,
        "batch_count": len(xlsx_paths),
        "xlsx_paths": xlsx_paths,
        "source": SOURCE,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = JsonArgumentParser(
        prog="python -m services.agent_cli.mabang.download_stock_sku_excel"
    )
    parser.add_argument("--delivery-no", default="")
    return parser


async def _run_async(args: argparse.Namespace) -> dict[str, Any]:
    delivery_no = _require_delivery_no(getattr(args, "delivery_no", ""))
    return await download_stock_sku_excel(delivery_no)


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
