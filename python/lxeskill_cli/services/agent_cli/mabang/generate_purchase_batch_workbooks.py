from __future__ import annotations

import argparse
import asyncio
from collections import OrderedDict
from datetime import date
from decimal import Decimal
from pathlib import Path
from typing import Any

from services.agent_cli._shared.json_cli import (
    JsonArgumentParser,
    configure_utf8_stdio,
    exception_text as _exception_text,
    write_json as _write_json,
)
from services.agent_cli.mabang import generate_fba_restock_workbook as restock_workbook
from services.agent_cli.mabang import generate_restock_workbook as purchase_summary
from shared.logging import setup_logging

SOURCE = "fba_purchase_batch_workbooks"

close_all_network_clients = purchase_summary.close_all_network_clients


def _single_delivery_summary_from_csv(
    delivery_no: str,
    csv_path: str | Path,
) -> tuple[OrderedDict[str, Decimal], OrderedDict[str, list[str]]]:
    summary = OrderedDict(
        (sku, quantity)
        for sku, quantity in purchase_summary.summarize_tax_sku_quantities_in_delivery_order(csv_path).items()
        if quantity > 0
    )
    if not summary:
        raise RuntimeError(f"发货单 CSV 汇总后没有正数 SKU 发货量: {delivery_no}")
    sku_sources = OrderedDict((sku, [delivery_no]) for sku in summary)
    return summary, sku_sources


def generate_purchase_batch_workbooks(
    delivery_nos: list[str],
    *,
    master_xlsx: str | Path,
    gross_margin: Any,
    csv_dir: str | Path | None = None,
    purchase_output_dir: str | Path | None = None,
    restock_output_dir: str | Path | None = None,
    today: date | None = None,
) -> dict[str, Any]:
    parsed_gross_margin = restock_workbook._parse_gross_margin(gross_margin)
    batch_summary, batch_sources, normalized_delivery_nos, csv_paths = purchase_summary.summarize_delivery_quantities(
        delivery_nos,
        csv_dir=csv_dir,
    )
    products = purchase_summary.load_master_products(master_xlsx)
    zhengfei_average_prices = purchase_summary.zhengfei_average_prices_for_summary(
        batch_summary,
        batch_sources,
        products,
    )
    summary_rows, manufacturer_rows, unmatched_rows, matched_sku_count, unmatched_sku_count = (
        purchase_summary.build_restock_rows(
            batch_summary,
            batch_sources,
            products,
            zhengfei_average_prices=zhengfei_average_prices,
        )
    )
    purchase_summary_xlsx = purchase_summary.write_restock_workbook(
        summary_rows,
        manufacturer_rows,
        unmatched_rows,
        delivery_nos=normalized_delivery_nos,
        output_dir=purchase_output_dir,
    )

    warnings = list(products.warnings)
    cross_manufacturer_model_count = restock_workbook._append_cross_manufacturer_model_warning(
        warnings,
        summary_rows,
    )
    output_date = today or date.today()
    restock_xlsx_paths: list[str] = []
    restock_outputs: list[dict[str, str]] = []
    restock_matched_sku_count = 0
    restock_unmatched_sku_count = 0
    for delivery_no, csv_path in zip(normalized_delivery_nos, csv_paths, strict=True):
        delivery_summary, delivery_sources = _single_delivery_summary_from_csv(delivery_no, csv_path)
        country, country_warnings = restock_workbook._delivery_country_metadata(csv_path)
        warnings.extend(country_warnings)
        restock_rows, _manufacturer_rows, delivery_unmatched_rows, delivery_matched_count, delivery_unmatched_count = (
            purchase_summary.build_restock_rows(
                delivery_summary,
                delivery_sources,
                products,
                zhengfei_average_prices=zhengfei_average_prices,
                collect_warnings=False,
            )
        )
        restock_xlsx = restock_workbook.write_fba_restock_workbook(
            restock_rows,
            delivery_unmatched_rows,
            delivery_no=delivery_no,
            country=country,
            gross_margin=parsed_gross_margin,
            today=output_date,
            output_dir=restock_output_dir,
        )
        restock_xlsx_paths.append(str(restock_xlsx))
        restock_outputs.append({"delivery_no": delivery_no, "output_xlsx": str(restock_xlsx)})
        restock_matched_sku_count += delivery_matched_count
        restock_unmatched_sku_count += delivery_unmatched_count

    return {
        "success": True,
        "delivery_nos": normalized_delivery_nos,
        "csv_paths": csv_paths,
        "master_xlsx": str(Path(master_xlsx).expanduser()),
        "gross_margin": str(parsed_gross_margin),
        "pricing_basis": restock_workbook.PRICING_BASIS,
        "purchase_summary_xlsx": str(purchase_summary_xlsx),
        "restock_xlsx_paths": restock_xlsx_paths,
        "restock_outputs": restock_outputs,
        "sku_count": len(batch_summary),
        "sku_source_count": sum(1 for sources in batch_sources.values() if sources),
        "matched_sku_count": matched_sku_count,
        "unmatched_sku_count": unmatched_sku_count,
        "restock_matched_sku_count": restock_matched_sku_count,
        "restock_unmatched_sku_count": restock_unmatched_sku_count,
        "manufacturer_count": len(manufacturer_rows),
        "cross_manufacturer_model_count": cross_manufacturer_model_count,
        "deduped_duplicate_sku_count": products.deduped_duplicate_sku_count,
        "deduped_duplicate_row_count": products.deduped_duplicate_row_count,
        "deduped_duplicate_sku_examples": products.deduped_duplicate_sku_examples,
        "skipped_empty_sku_row_count": products.skipped_empty_sku_row_count,
        "skipped_empty_sku_rows": products.skipped_empty_sku_rows,
        "unmerged_empty_model_sku_count": products.unmerged_empty_model_sku_count,
        "unmerged_empty_model_skus": products.unmerged_empty_model_skus,
        "contract_mapping_count": products.contract_mapping_count,
        "contract_unmapped_manufacturer_count": products.contract_unmapped_manufacturer_count,
        "contract_unmapped_manufacturer_examples": products.contract_unmapped_manufacturer_examples,
        "contract_conflict_manufacturer_count": products.contract_conflict_manufacturer_count,
        "contract_conflict_manufacturer_examples": products.contract_conflict_manufacturer_examples,
        "contract_prefix_conflict_manufacturer_count": products.contract_prefix_conflict_manufacturer_count,
        "contract_prefix_conflict_manufacturer_examples": products.contract_prefix_conflict_manufacturer_examples,
        "contract_tax_rate_conflict_manufacturer_count": products.contract_tax_rate_conflict_manufacturer_count,
        "contract_tax_rate_conflict_manufacturer_examples": products.contract_tax_rate_conflict_manufacturer_examples,
        "warnings": warnings,
        "source": SOURCE,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = JsonArgumentParser(
        prog="python -m services.agent_cli.mabang.generate_purchase_batch_workbooks"
    )
    parser.add_argument("--delivery-no", action="append", default=[])
    parser.add_argument("--master-xlsx", required=True)
    parser.add_argument("--gross-margin", required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    configure_utf8_stdio()
    setup_logging()
    delivery_nos: list[str] = []
    master_xlsx = ""
    gross_margin = ""
    try:
        args = build_parser().parse_args(argv)
        delivery_nos = list(getattr(args, "delivery_no", []) or [])
        master_xlsx = str(getattr(args, "master_xlsx", "") or "")
        gross_margin = str(getattr(args, "gross_margin", "") or "")
        payload = generate_purchase_batch_workbooks(
            delivery_nos,
            master_xlsx=master_xlsx,
            gross_margin=gross_margin,
        )
    except Exception as exc:
        payload = {
            "success": False,
            "delivery_nos": delivery_nos,
            "master_xlsx": master_xlsx,
            "gross_margin": gross_margin,
            "exception": _exception_text(exc),
            "source": SOURCE,
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
