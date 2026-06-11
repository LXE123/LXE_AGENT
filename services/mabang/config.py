from __future__ import annotations

from pathlib import Path

from shared.env_config import env_text


MABANG_ACCOUNT = env_text("MABANG_ACCOUNT", "")
MABANG_PASSWORD = env_text("MABANG_PASSWORD", "")

MABANG_STOCK_SKU_EXPORT_DIR = env_text("MABANG_STOCK_SKU_EXPORT_DIR", "")
MABANG_FBA_STORE_RESOLVER_OUTPUT_DIR = env_text("MABANG_FBA_STORE_RESOLVER_OUTPUT_DIR", "")
MABANG_STORE_MSKU_OUTPUT_DIR = env_text("MABANG_STORE_MSKU_OUTPUT_DIR", "")
MABANG_STORE_MSKU_ANALYSIS_OUTPUT_DIR = env_text("MABANG_STORE_MSKU_ANALYSIS_OUTPUT_DIR", "")
MABANG_STORE_MSKU_INVENTORY_OUTPUT_DIR = env_text("MABANG_STORE_MSKU_INVENTORY_OUTPUT_DIR", "")
MABANG_STORE_MSKU_REPLENISHMENT_OUTPUT_DIR = env_text("MABANG_STORE_MSKU_REPLENISHMENT_OUTPUT_DIR", "")
MABANG_MSKU_DETAIL_OUTPUT_DIR = env_text("MABANG_MSKU_DETAIL_OUTPUT_DIR", "")
FBA_DELIVERY_CSV_DIR = env_text("FBA_DELIVERY_CSV_DIR", "")


def configured_text(name: str, default: str) -> str:
    return env_text(name, default)


def configured_path(name: str, default: Path) -> Path:
    configured = env_text(name, "")
    return Path(configured) if configured else default


__all__ = [
    "FBA_DELIVERY_CSV_DIR",
    "MABANG_ACCOUNT",
    "MABANG_FBA_STORE_RESOLVER_OUTPUT_DIR",
    "MABANG_MSKU_DETAIL_OUTPUT_DIR",
    "MABANG_PASSWORD",
    "MABANG_STOCK_SKU_EXPORT_DIR",
    "MABANG_STORE_MSKU_ANALYSIS_OUTPUT_DIR",
    "MABANG_STORE_MSKU_INVENTORY_OUTPUT_DIR",
    "MABANG_STORE_MSKU_OUTPUT_DIR",
    "MABANG_STORE_MSKU_REPLENISHMENT_OUTPUT_DIR",
    "configured_path",
    "configured_text",
]
