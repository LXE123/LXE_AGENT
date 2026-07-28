from __future__ import annotations

from collections import OrderedDict
from datetime import date
from decimal import Decimal
from pathlib import Path
from typing import Any

from services.agent_cli._shared.json_cli import exception_text as _exception_text
from services.agent_cli.mabang import fill_purchase_contracts as contract_workbook
from services.agent_cli.mabang import generate_fba_restock_workbook as restock_workbook
from services.agent_cli.mabang import generate_restock_workbook as purchase_summary
from services.agent_cli.mabang import erp_purchase_batch

SOURCE = "fba_purchase_batch_workbooks"



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


def run(arguments: dict[str, Any]) -> dict[str, Any]:
    """lxeskill entrypoint — the catalog input_schema is the argument contract."""
    delivery_nos: list[str] = []
    master_xlsx = ""
    contract_template_xlsx = ""
    gross_margin = ""
    try:
        raw = arguments.get("delivery_no")
        delivery_nos = [raw] if isinstance(raw, str) else list(raw or [])
        master_xlsx = str(arguments.get("master_xlsx") or "")
        contract_template_xlsx = str(arguments.get("contract_template_xlsx") or "")
        gross_margin = str(arguments.get("gross_margin") or "")
        restock_workbook._parse_gross_margin(gross_margin)
        draft = bool(arguments.get("draft", False))
        confirm_quote_id = str(arguments.get("confirm_inventory_quote_id") or "").strip()
        replace_batch_id = str(arguments.get("replace_batch_id") or "").strip()
        expected_version_raw = arguments.get("expected_version_no")
        expected_version_no = int(expected_version_raw) if expected_version_raw not in (None, "") else None
        change_reason = str(arguments.get("change_reason") or "").strip()
        confirmation_arguments_present = any(
            (
                confirm_quote_id,
                replace_batch_id,
                expected_version_no is not None,
                change_reason,
            )
        )
        if draft and confirmation_arguments_present:
            raise erp_purchase_batch.PurchaseBatchClientError(
                "draft_arguments_conflict",
                "--draft 不能与 ERP 确认或批次替换参数同时使用",
            )
        if replace_batch_id and (expected_version_no is None or not change_reason):
            raise erp_purchase_batch.PurchaseBatchClientError(
                "replacement_arguments_incomplete",
                "--replace-batch-id 必须同时提供 --expected-version-no 和 --change-reason",
            )
        if not replace_batch_id and (expected_version_no is not None or change_reason):
            raise erp_purchase_batch.PurchaseBatchClientError(
                "replacement_arguments_incomplete",
                "--expected-version-no/--change-reason 必须与 --replace-batch-id 同时使用",
            )
        if draft:
            generated = generate_purchase_batch_workbooks(
                delivery_nos,
                master_xlsx=master_xlsx,
                gross_margin=gross_margin,
            )
            return erp_purchase_batch.mark_draft_workbooks(generated)

        request_payload, intent_context = erp_purchase_batch.build_purchase_intent(
            delivery_nos,
            master_xlsx=master_xlsx,
            confirm_inventory_quote_id=confirm_quote_id,
            replace_batch_id=replace_batch_id,
            expected_version_no=expected_version_no,
            change_reason=change_reason,
        )
        contract_workbook.validate_contract_template(
            contract_template_xlsx,
            [str(item.get("supplier_name") or "") for item in request_payload["contracts"]],
        )
        status_code, erp_result = erp_purchase_batch.import_purchase_intent(request_payload)
        if status_code == 409:
            erp_purchase_batch.validate_purchase_response(
                status_code=status_code,
                response=erp_result,
                request_payload=request_payload,
            )
            return {
                **erp_purchase_batch.confirmation_result(
                    response=erp_result,
                    status_code=status_code,
                    request_payload=request_payload,
                ),
                "delivery_nos": intent_context["delivery_nos"],
                "master_xlsx": master_xlsx,
                "contract_template_xlsx": contract_template_xlsx,
                "gross_margin": gross_margin,
                "source": SOURCE,
            }
        formal: dict[str, Any] | None = None
        try:
            erp_purchase_batch.validate_purchase_response(
                status_code=status_code,
                response=erp_result,
                request_payload=request_payload,
            )
            generated = generate_purchase_batch_workbooks(
                delivery_nos,
                master_xlsx=master_xlsx,
                gross_margin=gross_margin,
            )
            formal = erp_purchase_batch.apply_formal_erp_result(
                generated,
                erp_result,
                request_payload=request_payload,
            )
            contract_result = contract_workbook.fill_formal_purchase_contracts(
                purchase_summary_xlsx=formal["purchase_summary_xlsx"],
                contract_template_xlsx=contract_template_xlsx,
                contracts=formal["contracts"],
                purchase_lines=formal["purchase_lines"],
            )
            formal["contract_template_xlsx"] = contract_result["contract_template_xlsx"]
            formal["contract_outputs"] = contract_result["output_files"]
            formal["contract_xlsx_paths"] = [
                item["output_xlsx"] for item in contract_result["output_files"]
            ]
            formal["status"] = "completed"
            return formal
        except Exception as exc:
            if isinstance(
                exc,
                (
                    erp_purchase_batch.PurchaseBatchClientError,
                    erp_purchase_batch.ErpHttpError,
                ),
            ):
                artifact_error = erp_purchase_batch.client_error_payload(exc)
            else:
                artifact_error = {
                    "code": type(exc).__name__,
                    "message": _exception_text(exc),
                }
            failure = {
                "success": False,
                "status": "batch_committed_artifact_generation_failed",
                "delivery_nos": intent_context["delivery_nos"],
                "master_xlsx": master_xlsx,
                "contract_template_xlsx": contract_template_xlsx,
                "gross_margin": gross_margin,
                "request_id": request_payload["request_id"],
                "batch_id": erp_result.get("batch_id"),
                "batch_no": erp_result.get("batch_no"),
                "version_no": erp_result.get("version_no"),
                "contracts": erp_result.get("contracts") or [],
                "exception": _exception_text(exc),
                "error": {
                    "code": "batch_committed_artifact_generation_failed",
                    "message": (
                        "ERP 批次已经提交，但本地采购文件或合同附件生成失败: "
                        f"{_exception_text(exc)}"
                    ),
                },
                "artifact_error": artifact_error,
                "erp": erp_result,
                "source": SOURCE,
            }
            if formal is not None:
                failure["purchase_summary_xlsx"] = formal.get("purchase_summary_xlsx")
                failure["restock_xlsx_paths"] = list(formal.get("restock_xlsx_paths") or [])
                failure["restock_outputs"] = list(formal.get("restock_outputs") or [])
            partial_contracts = getattr(exc, "output_files", None)
            if isinstance(partial_contracts, list):
                failure["contract_outputs"] = partial_contracts
                failure["contract_xlsx_paths"] = [
                    str(item.get("output_xlsx") or "")
                    for item in partial_contracts
                    if isinstance(item, dict) and item.get("output_xlsx")
                ]
            return failure
    except (erp_purchase_batch.PurchaseBatchClientError, erp_purchase_batch.ErpHttpError) as exc:
        return {
            "success": False,
            "delivery_nos": delivery_nos,
            "master_xlsx": master_xlsx,
            "contract_template_xlsx": contract_template_xlsx,
            "gross_margin": gross_margin,
            "exception": _exception_text(exc),
            "error": erp_purchase_batch.client_error_payload(exc),
            "source": SOURCE,
        }
    except Exception as exc:  # noqa: BLE001 — failure context belongs in the payload
        message = _exception_text(exc)
        return {
            "success": False,
            "delivery_nos": delivery_nos,
            "master_xlsx": master_xlsx,
            "contract_template_xlsx": contract_template_xlsx,
            "gross_margin": gross_margin,
            "exception": message,
            "error": {"code": "purchase_batch_generation_failed", "message": message},
            "source": SOURCE,
        }
