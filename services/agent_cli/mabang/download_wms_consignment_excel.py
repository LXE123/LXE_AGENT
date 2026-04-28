from __future__ import annotations

import argparse
import asyncio
import json
import sys
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

from services.agent_cli._shared.json_output import configure_utf8_stdio
from services.mabang.amazon.fba import download_consignment_excel_from_wms
from shared.infra.net import close_all_network_clients

PREFERRED_SHEET_NAME = "FBA装箱任务"
BOX_SPLIT_SIZE = 5
BOX_COLUMN_ALIASES = ("箱子编号", "箱序号", "箱号", "Box No", "Box Number")


class JsonArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise ValueError(str(message or "").strip() or "参数解析失败")


def _write_json(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(dict(payload or {}), ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _exception_text(exc: Exception) -> str:
    message = str(exc or "").strip()
    return message or exc.__class__.__name__


def _normalize_ship_no(value: Any) -> str:
    return str(value or "").strip().upper()


def _normalize_box_key(value: Any) -> str:
    text = str(value or "").strip()
    if not text or text.lower() == "nan":
        return ""
    try:
        numeric = Decimal(text)
    except (InvalidOperation, TypeError, ValueError):
        return text
    integral = numeric.to_integral_value()
    if numeric == integral:
        return str(int(integral))
    return format(numeric.normalize(), "f").rstrip("0").rstrip(".")


def _box_sort_key(value: str) -> tuple[int, str]:
    try:
        return 0, f"{int(value):08d}"
    except Exception:
        return 1, str(value)


def _column_matches_alias(column: str, alias: str) -> bool:
    current = str(column or "").strip()
    target = str(alias or "").strip()
    if not current or not target:
        return False
    return current == target or target in current


def _resolve_box_columns(columns: list[str]) -> list[str]:
    found: list[str] = []
    for alias in BOX_COLUMN_ALIASES:
        for column in columns:
            if column in found:
                continue
            if _column_matches_alias(column, alias):
                found.append(column)
    return found


def _select_sheet_name(sheet_names: list[str]) -> str:
    if PREFERRED_SHEET_NAME in sheet_names:
        return PREFERRED_SHEET_NAME
    if not sheet_names:
        raise RuntimeError("WMS Excel 没有可用 sheet")
    return str(sheet_names[0])


def split_consignment_excel_by_box(excel_path: str | Path, *, box_limit: int = BOX_SPLIT_SIZE) -> dict[str, Any]:
    try:
        import pandas as pd
    except Exception as exc:
        raise RuntimeError("缺少 pandas 依赖，无法拆分 WMS 装箱 Excel") from exc

    source_path = Path(excel_path).expanduser()
    if not source_path.is_absolute():
        source_path = (Path.cwd() / source_path).resolve()
    else:
        source_path = source_path.resolve()
    if not source_path.is_file():
        raise RuntimeError(f"找不到 WMS 装箱 Excel: {source_path}")

    try:
        with pd.ExcelFile(source_path) as workbook:
            sheet_name = _select_sheet_name([str(name) for name in workbook.sheet_names])
            df = pd.read_excel(workbook, sheet_name=sheet_name)
    except Exception as exc:
        raise RuntimeError(f"读取 WMS 装箱 Excel 失败: {source_path.name}, error={exc}") from exc

    if df.empty:
        raise RuntimeError(f"WMS 装箱 Excel 没有数据: {source_path.name}")

    columns = [str(column) for column in list(df.columns)]
    df.columns = columns
    box_columns = _resolve_box_columns(columns)
    if not box_columns:
        raise RuntimeError(f"WMS 装箱 Excel 缺少箱号列: {source_path.name}")

    grouping_column = box_columns[0]
    box_keys = df[grouping_column].map(_normalize_box_key)
    missing_rows = [str(index + 2) for index, value in enumerate(list(box_keys)) if not value]
    if missing_rows:
        preview = ", ".join(missing_rows[:10])
        suffix = " ..." if len(missing_rows) > 10 else ""
        raise RuntimeError(f"WMS 装箱 Excel 箱号列存在空值: rows={preview}{suffix}")

    ordered_boxes = sorted(set(str(value) for value in list(box_keys)), key=_box_sort_key)
    box_count = len(ordered_boxes)
    if box_count <= 0:
        raise RuntimeError(f"WMS 装箱 Excel 未解析到有效箱号: {source_path.name}")
    if box_count <= int(box_limit):
        return {
            "box_count": box_count,
            "split_required": False,
            "split_excel_paths": [],
        }

    split_paths: list[str] = []
    normalized_keys = [str(value) for value in list(box_keys)]
    for part_index, start in enumerate(range(0, box_count, int(box_limit)), start=1):
        group_boxes = ordered_boxes[start : start + int(box_limit)]
        group_set = set(group_boxes)
        box_number_map = {box_key: index for index, box_key in enumerate(group_boxes, start=1)}
        selected_mask = [box_key in group_set for box_key in normalized_keys]
        selected_keys = [box_key for box_key in normalized_keys if box_key in group_set]
        selected = df[selected_mask].copy()
        for column in box_columns:
            selected[column] = [box_number_map[box_key] for box_key in selected_keys]

        target_path = source_path.with_name(f"{source_path.stem}-{part_index}.xlsx")
        selected.to_excel(target_path, sheet_name=sheet_name[:31] or "Sheet1", index=False)
        split_paths.append(str(target_path))

    return {
        "box_count": box_count,
        "split_required": True,
        "split_excel_paths": split_paths,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = JsonArgumentParser(
        prog="python -m services.agent_cli.mabang.download_wms_consignment_excel"
    )
    parser.add_argument("--ship-no", default="")
    return parser


async def _run_async(args: argparse.Namespace) -> dict[str, Any]:
    ship_no = _normalize_ship_no(getattr(args, "ship_no", ""))
    if not ship_no:
        raise ValueError("ship_no 不能为空")
    if not ship_no.startswith("SP"):
        raise ValueError(f"ship_no 格式无效: {ship_no}")

    excel_path = await download_consignment_excel_from_wms(ship_no)
    split_payload = split_consignment_excel_by_box(excel_path)
    return {
        "success": True,
        "ship_no": ship_no,
        "excel_path": str(Path(excel_path)),
        "source": "wms",
        **split_payload,
    }


def main(argv: list[str] | None = None) -> int:
    configure_utf8_stdio()
    ship_no = ""
    try:
        args = build_parser().parse_args(argv)
        ship_no = _normalize_ship_no(getattr(args, "ship_no", ""))
        payload = asyncio.run(_run_async(args))
    except Exception as exc:
        payload = {
            "success": False,
            "ship_no": ship_no,
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
