"""Shared helpers for locating and reading Mabang WMS consignment workbooks."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from .consignment_paths import resolve_wms_consignment_dir


def normalize_consignment_no(value: Any) -> str:
    return str(value or "").strip().upper()


def resolve_consignment_excel_dir() -> Path:
    """Return the workspace-local WMS consignment workbook directory."""
    return resolve_wms_consignment_dir()


def find_consignment_excel(consignment_no: str) -> Path:
    """Find a cached WMS consignment workbook by consignment number."""
    base_dir = resolve_consignment_excel_dir()
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


def resolve_column(df_columns: list[str], aliases: tuple[str, ...]) -> str | None:
    """Resolve an input column using exact aliases before substring matches."""
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


__all__ = [
    "find_consignment_excel",
    "normalize_consignment_no",
    "resolve_column",
    "resolve_consignment_excel_dir",
]
