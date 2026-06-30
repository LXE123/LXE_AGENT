from __future__ import annotations

from pathlib import Path
from typing import Any

from services.agent_cli.mabang import generate_restock_workbook as _impl

DELIVERY_CSV_DIR = _impl.DELIVERY_CSV_DIR
OUTPUT_DIR = _impl.OUTPUT_DIR
SOURCE = _impl.SOURCE

load_master_products = _impl.load_master_products
summarize_delivery_quantities = _impl.summarize_delivery_quantities
summarize_tax_sku_quantities_in_delivery_order = _impl.summarize_tax_sku_quantities_in_delivery_order
build_restock_rows = _impl.build_restock_rows
write_restock_workbook = _impl.write_restock_workbook
close_all_network_clients = _impl.close_all_network_clients


def _sync_runtime_overrides() -> None:
    _impl.DELIVERY_CSV_DIR = DELIVERY_CSV_DIR
    _impl.OUTPUT_DIR = OUTPUT_DIR
    _impl.close_all_network_clients = close_all_network_clients


def generate_purchase_summary_workbook(
    delivery_nos: list[str],
    *,
    master_xlsx: str | Path,
    csv_dir: str | Path | None = None,
    output_dir: str | Path | None = None,
) -> dict[str, Any]:
    _sync_runtime_overrides()
    return _impl.generate_restock_workbook(
        delivery_nos,
        master_xlsx=master_xlsx,
        csv_dir=csv_dir,
        output_dir=output_dir,
    )


def generate_restock_workbook(
    delivery_nos: list[str],
    *,
    master_xlsx: str | Path,
    csv_dir: str | Path | None = None,
    output_dir: str | Path | None = None,
) -> dict[str, Any]:
    return generate_purchase_summary_workbook(
        delivery_nos,
        master_xlsx=master_xlsx,
        csv_dir=csv_dir,
        output_dir=output_dir,
    )


def build_parser():
    return _impl.build_parser(
        prog="python -m services.agent_cli.mabang.generate_purchase_summary_workbook"
    )


def main(argv: list[str] | None = None) -> int:
    _sync_runtime_overrides()
    return _impl.main(
        argv,
        prog="python -m services.agent_cli.mabang.generate_purchase_summary_workbook",
    )


if __name__ == "__main__":
    raise SystemExit(main())
