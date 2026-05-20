"""托运单 Excel 获取与定位辅助。"""

from __future__ import annotations

from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

from shared.config import config
from services.mabang.amazon.fba import download_consignment_excel_from_wms
from services.mabang.amazon.fba.consignment_paths import resolve_wms_consignment_dir
from shared.logging import logger

from ..input.validator import normalize_consignment_no


def _parse_bool(value: Any, default: bool = False) -> bool:
    """解析宽松布尔值。"""
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    text = str(value).strip().lower()
    if text in {"1", "true", "yes", "y", "on", "是", "开启"}:
        return True
    if text in {"0", "false", "no", "n", "off", "否", "关闭"}:
        return False
    return default


def resolve_test_file_dir() -> Path:
    """解析本地托运单 Excel 缓存目录。"""
    return resolve_wms_consignment_dir()


def find_consignment_excel(consignment_no: str) -> Path:
    """按托运单号查找本地 Excel。"""
    base_dir = resolve_test_file_dir()
    if not base_dir.exists():
        raise FileNotFoundError(f"托运单 Excel 缓存目录不存在: {base_dir}")

    key = normalize_consignment_no(consignment_no)
    candidates = [
        base_dir / f"{key}.xls",
        base_dir / f"{key}.xlsx",
        base_dir / f"{key.lower()}.xls",
        base_dir / f"{key.lower()}.xlsx",
    ]
    for path in candidates:
        if path.exists():
            return path
    raise FileNotFoundError(f"未找到托运单Excel: {key} (目录: {base_dir})")


def find_unique_local_consignment_excel(consignment_no: str) -> Path:
    """按托运单号查找唯一的本地 Excel。"""
    base_dir = resolve_test_file_dir()
    if not base_dir.exists():
        raise FileNotFoundError(f"托运单 Excel 缓存目录不存在: {base_dir}")

    key = normalize_consignment_no(consignment_no)
    candidates = [
        base_dir / f"{key}.xls",
        base_dir / f"{key}.xlsx",
        base_dir / f"{key.lower()}.xls",
        base_dir / f"{key.lower()}.xlsx",
    ]
    matches: list[Path] = []
    seen: set[str] = set()
    for path in candidates:
        if not path.exists():
            continue
        resolved = str(path.resolve()).lower()
        if resolved in seen:
            continue
        seen.add(resolved)
        matches.append(path)

    if not matches:
        raise FileNotFoundError(f"未找到托运单Excel: {key} (目录: {base_dir})")
    if len(matches) > 1:
        joined = ", ".join(path.name for path in matches)
        raise RuntimeError(f"找到多个托运单Excel，请只保留一个文件: {joined}")
    return matches[0]


async def ensure_consignment_excel_ready(consignment_no: str) -> Path:
    """优先通过 WMS 导出托运单 Excel，失败时回退本地文件。"""
    normalized = normalize_consignment_no(consignment_no)
    enable_export = _parse_bool(getattr(config, "FBA_LOGISTICS_ENABLE_WMS_EXPORT", True), True)
    strict_export = _parse_bool(getattr(config, "FBA_LOGISTICS_WMS_EXPORT_STRICT", True), True)
    wms_error: Exception | None = None

    if enable_export:
        try:
            return await download_consignment_excel_from_wms(normalized)
        except Exception as exc:
            wms_error = exc
            if strict_export:
                raise RuntimeError(f"WMS导出失败且严格模式开启: {normalized}, error={exc}") from exc
            logger.warning(f"[FBA Logistics] WMS导出失败，回退本地Excel: {normalized}, error={exc}")

    try:
        return find_consignment_excel(normalized)
    except Exception as exc:
        if wms_error is not None:
            raise RuntimeError(
                f"WMS导出失败后回退本地Excel也失败: {normalized}, wms_error={wms_error}, local_error={exc}"
            ) from exc
        raise


def resolve_column(df_columns: list[str], aliases: tuple[str, ...]) -> str | None:
    """按别名集合查找列名。"""
    normalized = {str(column).strip(): str(column) for column in df_columns}
    for name in aliases:
        if name in normalized:
            return normalized[name]
    for column in df_columns:
        current = str(column).strip()
        for alias in aliases:
            if alias in current:
                return str(column)
    return None


def _normalize_box_no(value: Any) -> str:
    text = str(value or "").strip()
    if not text or text.lower() == "nan":
        raise RuntimeError("托运单 Excel 缺少有效箱号")
    try:
        numeric = Decimal(text)
    except (InvalidOperation, TypeError, ValueError):
        return text
    integral = numeric.to_integral_value()
    if numeric == integral:
        return str(int(integral))
    return format(numeric.normalize(), "f").rstrip("0").rstrip(".")


def _normalize_sequence_no(value: Any) -> str:
    text = str(value or "").strip()
    if not text or text.lower() == "nan":
        raise RuntimeError("托运单 Excel 第一列缺少有效序号")
    try:
        numeric = Decimal(text)
    except (InvalidOperation, TypeError, ValueError) as exc:
        raise RuntimeError(f"托运单 Excel 第一列序号无法解析: value={value}") from exc
    integral = numeric.to_integral_value()
    if numeric != integral or integral <= 0:
        raise RuntimeError(f"托运单 Excel 第一列序号必须为正整数: value={value}")
    return str(int(integral))


def _normalize_positive_number(value: Any, *, field_name: str, box_no: str) -> str:
    text = str(value or "").strip()
    if not text or text.lower() == "nan":
        raise RuntimeError(f"托运单 Excel 缺少 {field_name}: 箱号={box_no}")
    try:
        numeric = Decimal(text)
    except (InvalidOperation, TypeError, ValueError) as exc:
        raise RuntimeError(f"托运单 Excel 的 {field_name} 无法解析: 箱号={box_no}, value={value}") from exc
    if numeric <= 0:
        raise RuntimeError(f"托运单 Excel 的 {field_name} 必须大于 0: 箱号={box_no}, value={value}")
    integral = numeric.to_integral_value()
    if numeric == integral:
        return str(int(integral))
    return format(numeric.normalize(), "f").rstrip("0").rstrip(".")


def _box_sort_key(box_no: str) -> tuple[int, str]:
    try:
        return 0, f"{int(box_no):08d}"
    except Exception:
        return 1, str(box_no)


def load_pricing_boxes_from_local_excel(consignment_no: str) -> tuple[Path, list[dict[str, str]]]:
    """按托运单号读取本地装箱文件中的箱规数据。"""
    try:
        import pandas as pd
    except Exception as exc:
        raise RuntimeError("缺少 pandas 依赖，无法读取托运单 Excel") from exc

    excel_path = find_unique_local_consignment_excel(consignment_no)
    try:
        with pd.ExcelFile(excel_path) as workbook:
            sheet_names = [str(name) for name in workbook.sheet_names]
    except Exception as exc:
        raise RuntimeError(f"读取托运单 Excel 失败: {excel_path.name}, error={exc}") from exc

    if not sheet_names:
        raise RuntimeError(f"托运单 Excel 没有可用 sheet: {excel_path.name}")

    target_sheet = "FBA装箱任务" if "FBA装箱任务" in sheet_names else sheet_names[0]
    try:
        df = pd.read_excel(excel_path, sheet_name=target_sheet)
    except Exception as exc:
        raise RuntimeError(f"读取托运单 Excel sheet 失败: {excel_path.name}#{target_sheet}, error={exc}") from exc

    if df.empty:
        raise RuntimeError(f"托运单 Excel 没有数据: {excel_path.name}")

    columns = [str(column) for column in list(df.columns)]
    sequence_col = str(columns[0]).strip() if columns else ""
    if not sequence_col:
        raise RuntimeError(f"托运单 Excel 缺少第一列序号: {excel_path.name}")
    box_no_col = resolve_column(columns, ("箱子编号", "箱序号", "箱号", "Box No", "Box Number"))
    gross_weight_col = resolve_column(columns, ("毛重", "Gross Weight", "gross_weight", "weight"))
    length_col = resolve_column(columns, ("长", "长度", "Length", "length"))
    width_col = resolve_column(columns, ("宽", "Width", "width"))
    height_col = resolve_column(columns, ("高", "Height", "height"))

    missing = [
        name
        for name, column in (
            ("箱号", box_no_col),
            ("毛重", gross_weight_col),
            ("长", length_col),
            ("宽", width_col),
            ("高", height_col),
        )
        if not column
    ]
    if missing:
        raise RuntimeError(f"托运单 Excel 缺少必需列: {', '.join(missing)}")

    boxes_by_sequence: dict[str, dict[str, str]] = {}
    selected_columns: list[str] = []
    for column in (sequence_col, box_no_col, gross_weight_col, length_col, width_col, height_col):
        if column and column not in selected_columns:
            selected_columns.append(column)
    for row in df[selected_columns].to_dict(orient="records"):
        sequence_no = _normalize_sequence_no(row.get(sequence_col))
        box_no = _normalize_box_no(row.get(box_no_col))
        current = {
            "sequence_no": sequence_no,
            "box_no": box_no,
            "gross_weight": _normalize_positive_number(row.get(gross_weight_col), field_name="毛重", box_no=box_no),
            "length": _normalize_positive_number(row.get(length_col), field_name="长", box_no=box_no),
            "width": _normalize_positive_number(row.get(width_col), field_name="宽", box_no=box_no),
            "height": _normalize_positive_number(row.get(height_col), field_name="高", box_no=box_no),
        }
        existing = boxes_by_sequence.get(sequence_no)
        if existing is not None and existing != current:
            raise RuntimeError(f"托运单 Excel 第一列序号重复且箱规冲突: 序号={sequence_no}")
        boxes_by_sequence[sequence_no] = current

    if not boxes_by_sequence:
        raise RuntimeError(f"托运单 Excel 未解析到有效箱规: {excel_path.name}")

    ordered_boxes = [
        dict(boxes_by_sequence[sequence_no])
        for sequence_no in sorted(boxes_by_sequence.keys(), key=_box_sort_key)
    ]
    return excel_path, ordered_boxes
