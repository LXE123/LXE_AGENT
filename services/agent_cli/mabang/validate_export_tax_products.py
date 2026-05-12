from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path
from typing import Any

from services.agent_cli._shared.json_output import configure_utf8_stdio
from services.agent_cli.mabang.summarize_fba_delivery_tax_sku import (
    EXPORT_TAX_PRODUCTS_PATH,
    EXPORT_TAX_PRODUCTS_SHEET,
    TAX_PRODUCT_NAME_COLUMN,
    TAX_PRODUCT_SKU_COLUMN,
)

SOURCE = "export_tax_products_validation"
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


def _clean_cell(value: Any) -> str:
    text = str(value or "").strip()
    if text.lower() == "nan":
        return ""
    return text


def _sku_match_key(value: Any) -> str:
    return WHITESPACE_PATTERN.sub("", _clean_cell(value))


def _read_products_frame(products_path: Path):
    try:
        import pandas as pd
    except Exception as exc:
        raise RuntimeError("缺少 pandas 依赖，无法读取出口退税产品表") from exc

    try:
        excel_file = pd.ExcelFile(products_path)
    except Exception as exc:
        raise RuntimeError(f"读取出口退税产品表失败: {products_path}, error={exc}") from exc

    if EXPORT_TAX_PRODUCTS_SHEET not in excel_file.sheet_names:
        raise RuntimeError(f"出口退税产品表缺少 sheet: {EXPORT_TAX_PRODUCTS_SHEET}")

    try:
        df = pd.read_excel(products_path, sheet_name=EXPORT_TAX_PRODUCTS_SHEET, dtype=str)
    except Exception as exc:
        raise RuntimeError(
            f"读取出口退税产品表失败: {products_path}, sheet={EXPORT_TAX_PRODUCTS_SHEET}, error={exc}"
        ) from exc
    columns = [str(column or "").strip() for column in list(df.columns)]
    df.columns = columns
    return df


def validate_export_tax_products(products_path: str | Path | None = None) -> dict[str, Any]:
    source_path = Path(EXPORT_TAX_PRODUCTS_PATH if products_path is None else products_path)
    if not source_path.is_file():
        raise RuntimeError(f"找不到出口退税产品表: {source_path}")

    df = _read_products_frame(source_path)
    columns = [str(column or "").strip() for column in list(df.columns)]
    missing_columns = [
        column
        for column in (TAX_PRODUCT_SKU_COLUMN, TAX_PRODUCT_NAME_COLUMN)
        if column not in columns
    ]
    if missing_columns:
        raise RuntimeError(f"出口退税产品表缺少列: {', '.join(missing_columns)}")

    sku_keys: list[str] = []
    empty_rows: list[int] = []
    for index, row in enumerate(df.to_dict(orient="records"), start=2):
        key = _sku_match_key(row.get(TAX_PRODUCT_SKU_COLUMN))
        if not key:
            empty_rows.append(index)
            continue
        sku_keys.append(key)

    if empty_rows:
        sample = ", ".join(str(row_number) for row_number in empty_rows[:10])
        raise RuntimeError(f"出口退税产品表存在空 sku: count={len(empty_rows)}, rows={sample}")
    if not sku_keys:
        raise RuntimeError("出口退税产品表没有有效 sku")

    counts = Counter(sku_keys)
    duplicate_examples = [sku for sku, count in counts.items() if count > 1][:20]
    duplicate_sku_count = sum(1 for count in counts.values() if count > 1)
    duplicate_row_count = sum(count - 1 for count in counts.values() if count > 1)

    return {
        "success": True,
        "products_path": str(source_path),
        "sheet_name": EXPORT_TAX_PRODUCTS_SHEET,
        "row_count": int(len(df)),
        "valid_sku_count": int(len(sku_keys)),
        "unique_sku_count": int(len(counts)),
        "empty_sku_count": 0,
        "duplicate_sku_count": int(duplicate_sku_count),
        "duplicate_row_count": int(duplicate_row_count),
        "duplicate_sku_examples": duplicate_examples,
        "duplicate_policy": "keep_first",
        "source": SOURCE,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = JsonArgumentParser(
        prog="python -m services.agent_cli.mabang.validate_export_tax_products"
    )
    parser.add_argument("--path", default=str(EXPORT_TAX_PRODUCTS_PATH))
    return parser


def main(argv: list[str] | None = None) -> int:
    configure_utf8_stdio()
    products_path = ""
    try:
        args = build_parser().parse_args(argv)
        products_path = str(getattr(args, "path", "") or "").strip()
        payload = validate_export_tax_products(products_path)
    except Exception as exc:
        payload = {
            "success": False,
            "products_path": products_path,
            "exception": _exception_text(exc),
        }

    _write_json(payload)
    return 0 if bool(payload.get("success")) else 1


if __name__ == "__main__":
    raise SystemExit(main())
