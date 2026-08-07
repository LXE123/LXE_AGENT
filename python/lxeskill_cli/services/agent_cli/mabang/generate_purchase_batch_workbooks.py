from __future__ import annotations

from collections import OrderedDict
from datetime import date
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Mapping

from services.agent_cli._shared.json_cli import exception_text as _exception_text
from services.agent_cli.mabang import fill_purchase_contracts as contract_workbook
from services.agent_cli.mabang import generate_fba_restock_workbook as restock_workbook
from services.agent_cli.mabang import generate_restock_workbook as purchase_summary
from services.agent_cli.mabang import erp_purchase_batch

SOURCE = "fba_purchase_batch_workbooks"
FORMAL_SUCCESS_RESULT_SCHEMA = "lxe.fba.purchase-summary-result.v1"
ARTIFACT_SNAPSHOT_SCHEMA = "lxe.erp.purchase-artifact-snapshot.v1"

_FORMAL_DIAGNOSTIC_COUNT_FIELDS = (
    "sku_count",
    "sku_source_count",
    "matched_sku_count",
    "unmatched_sku_count",
    "restock_matched_sku_count",
    "restock_unmatched_sku_count",
    "manufacturer_count",
    "cross_manufacturer_model_count",
    "deduped_duplicate_sku_count",
    "deduped_duplicate_row_count",
    "skipped_empty_sku_row_count",
    "unmerged_empty_model_sku_count",
    "contract_mapping_count",
    "contract_unmapped_manufacturer_count",
    "contract_conflict_manufacturer_count",
    "contract_prefix_conflict_manufacturer_count",
    "contract_tax_rate_conflict_manufacturer_count",
)


def _quantity_text(value: Decimal) -> str:
    if value == value.to_integral_value():
        return str(int(value))
    return format(value.normalize(), "f").rstrip("0").rstrip(".")


def _formal_success_result(
    formal: Mapping[str, Any],
    erp_result: Mapping[str, Any],
    contract_result: Mapping[str, Any],
    intent_context: Mapping[str, Any],
) -> dict[str, Any]:
    """Expose only the decision and delivery summary after all formal artifacts exist."""
    purchase_lines = list(erp_result.get("purchase_lines") or [])
    quantity_fields = (
        "planned_shipment_quantity",
        "carryover_applied_quantity",
        "purchase_quantity",
    )
    quantity_summary = {
        field: _quantity_text(
            sum((Decimal(str(line[field])) for line in purchase_lines), Decimal("0"))
        )
        for field in quantity_fields
    }

    server_contracts = {
        str(item.get("supplier_name") or ""): item
        for item in list(erp_result.get("contracts") or [])
        if isinstance(item, Mapping)
    }
    contracts: list[dict[str, Any]] = []
    for raw_output in list(contract_result.get("output_files") or []):
        if not isinstance(raw_output, Mapping):
            continue
        supplier_name = str(raw_output.get("manufacturer") or "")
        server_contract = server_contracts.get(supplier_name, {})
        contracts.append(
            {
                "contract_id": server_contract.get("contract_id"),
                "supplier_name": supplier_name,
                "contract_no": raw_output.get("contract_no"),
                "daily_sequence": server_contract.get("daily_sequence"),
                "supplier_contract_sequence": server_contract.get(
                    "supplier_contract_sequence"
                ),
                "supplier_contract_count": server_contract.get(
                    "supplier_contract_count"
                ),
                "output_xlsx": raw_output.get("output_xlsx"),
            }
        )

    delivery_nos = list(formal.get("delivery_nos") or erp_result.get("sp_nos") or [])
    restock_xlsx_paths = list(formal.get("restock_xlsx_paths") or [])
    contract_xlsx_paths = [
        str(item.get("output_xlsx") or "")
        for item in contracts
        if item.get("output_xlsx")
    ]
    warnings = [
        *list(formal.get("warnings") or []),
        *list(contract_result.get("warnings") or []),
    ]
    unmatched_summary = dict(intent_context.get("unmatched_summary") or {})
    if unmatched_summary.get("sp_sku_count"):
        warnings.append(
            "本批次有 "
            f"{unmatched_summary.get('stock_sku_count', 0)} 个未匹配库存 SKU（"
            f"{unmatched_summary.get('component_count', 0)} 个 MSKU 组件，计划量 "
            f"{unmatched_summary.get('planned_shipment_quantity', '0')}），"
            "已保留组成关系但未纳入采购、库存和装箱对账。"
        )
    result: dict[str, Any] = {
        "success": True,
        "status": "completed",
        "result_schema": FORMAL_SUCCESS_RESULT_SCHEMA,
        "mode": "formal",
        "erp_synced": True,
        "erp_status": erp_result.get("status"),
        "batch_id": erp_result.get("batch_id"),
        "batch_no": erp_result.get("batch_no"),
        "revision_id": erp_result.get("revision_id"),
        "version_no": erp_result.get("version_no"),
        "delivery_nos": delivery_nos,
        "quantity_summary": quantity_summary,
        "artifact_summary": {
            "delivery_count": len(delivery_nos),
            "restock_count": len(restock_xlsx_paths),
            "contract_count": len(contracts),
            "deliverable_file_count": 1 + len(restock_xlsx_paths) + len(contract_xlsx_paths),
        },
        "purchase_line_count": len(purchase_lines),
        "unmatched_summary": unmatched_summary,
        "contracts": contracts,
        "purchase_summary_xlsx": formal.get("purchase_summary_xlsx"),
        "restock_xlsx_paths": restock_xlsx_paths,
        "contract_xlsx_paths": contract_xlsx_paths,
        "gross_margin": formal.get("gross_margin"),
        "pricing_basis": formal.get("pricing_basis"),
        "warnings": warnings,
        "source": formal.get("source") or SOURCE,
    }
    for field in _FORMAL_DIAGNOSTIC_COUNT_FIELDS:
        if field in formal:
            result[field] = formal[field]
    return result



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


def _snapshot_mapping(value: Any, *, field: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise erp_purchase_batch.PurchaseBatchClientError(
            "purchase_batch_artifact_snapshot_invalid",
            f"ERP 采购文件快照字段 `{field}` 必须是对象",
            detail={"field": field},
        )
    return value


def _snapshot_list(value: Any, *, field: str) -> list[Any]:
    if not isinstance(value, list):
        raise erp_purchase_batch.PurchaseBatchClientError(
            "purchase_batch_artifact_snapshot_invalid",
            f"ERP 采购文件快照字段 `{field}` 必须是数组",
            detail={"field": field},
        )
    return value


def _snapshot_text(value: Any, *, field: str) -> str:
    text = str(value or "").strip()
    if not text:
        raise erp_purchase_batch.PurchaseBatchClientError(
            "purchase_batch_artifact_snapshot_invalid",
            f"ERP 采购文件快照缺少字段 `{field}`",
            detail={"field": field},
        )
    return text


def _snapshot_decimal(value: Any, *, field: str) -> Decimal:
    if isinstance(value, bool) or value in (None, ""):
        raise erp_purchase_batch.PurchaseBatchClientError(
            "purchase_batch_artifact_snapshot_invalid",
            f"ERP 采购文件快照缺少数值字段 `{field}`",
            detail={"field": field},
        )
    try:
        result = Decimal(str(value))
    except (InvalidOperation, ValueError) as exc:
        raise erp_purchase_batch.PurchaseBatchClientError(
            "purchase_batch_artifact_snapshot_invalid",
            f"ERP 采购文件快照字段 `{field}` 不是有效数字: {value}",
            detail={"field": field},
        ) from exc
    if not result.is_finite() or result < 0:
        raise erp_purchase_batch.PurchaseBatchClientError(
            "purchase_batch_artifact_snapshot_invalid",
            f"ERP 采购文件快照字段 `{field}` 必须是非负有限数字: {value}",
            detail={"field": field},
        )
    return result


def _snapshot_row(
    line: Mapping[str, Any],
    details: list[Mapping[str, Any]],
    *,
    product_names: Mapping[tuple[str, str], str],
    field: str,
) -> list[Any]:
    manufacturer = _snapshot_text(line.get("supplier_name"), field=f"{field}.supplier_name")
    model = _snapshot_text(line.get("model"), field=f"{field}.model")
    original_price = _snapshot_decimal(
        line.get("source_tax_unit_price"),
        field=f"{field}.source_tax_unit_price",
    )
    stock_sku_quantities: OrderedDict[str, Decimal] = OrderedDict()
    stock_sku_product_names: OrderedDict[str, str] = OrderedDict()
    source_sps: list[str] = []
    for detail_index, detail in enumerate(details):
        detail_field = f"{field}.allocation_details[{detail_index}]"
        sp_no = _snapshot_text(detail.get("sp_no"), field=f"{detail_field}.sp_no").upper()
        stock_sku = _snapshot_text(
            detail.get("stock_sku"),
            field=f"{detail_field}.stock_sku",
        ).upper()
        quantity = _snapshot_decimal(
            detail.get("quantity"),
            field=f"{detail_field}.quantity",
        )
        if quantity <= 0:
            raise erp_purchase_batch.PurchaseBatchClientError(
                "purchase_batch_artifact_snapshot_invalid",
                f"ERP 采购文件快照分配数量必须为正数: {sp_no}/{stock_sku}",
                detail={"field": f"{detail_field}.quantity"},
            )
        product_name = product_names.get((sp_no, stock_sku))
        if not product_name:
            raise erp_purchase_batch.PurchaseBatchClientError(
                "purchase_batch_artifact_snapshot_invalid",
                f"ERP 采购文件快照缺少冻结产品名称: {sp_no}/{stock_sku}",
                detail={"field": f"{detail_field}.stock_sku"},
            )
        if sp_no not in source_sps:
            source_sps.append(sp_no)
        previous_name = stock_sku_product_names.setdefault(stock_sku, product_name)
        if previous_name != product_name:
            raise erp_purchase_batch.PurchaseBatchClientError(
                "purchase_batch_artifact_snapshot_invalid",
                f"ERP 采购文件快照同一 SKU 的产品名称不一致: {stock_sku}",
                detail={"field": f"{detail_field}.stock_sku"},
            )
        stock_sku_quantities[stock_sku] = (
            stock_sku_quantities.get(stock_sku, Decimal("0")) + quantity
        )
    if not stock_sku_quantities:
        raise erp_purchase_batch.PurchaseBatchClientError(
            "purchase_batch_artifact_snapshot_invalid",
            f"ERP 采购文件快照采购行没有来源分配: {manufacturer}/{model}",
            detail={"field": f"{field}.allocation_details"},
        )

    quantity = sum(stock_sku_quantities.values(), Decimal("0"))
    average_price: Decimal | str = ""
    average_total: Decimal | str = ""
    tax_unit_price = line.get("tax_unit_price")
    if purchase_summary._is_zhengfei_manufacturer(manufacturer):
        purchase_quantity = _snapshot_decimal(
            line.get("purchase_quantity"),
            field=f"{field}.purchase_quantity",
        )
        if purchase_quantity > 0 and tax_unit_price in (None, ""):
            raise erp_purchase_batch.PurchaseBatchClientError(
                "purchase_batch_artifact_snapshot_invalid",
                "ERP 采购文件快照中的正飞本次采购行缺少合同均价: "
                f"{manufacturer}/{model}",
                detail={"field": f"{field}.tax_unit_price"},
            )
        if tax_unit_price not in (None, ""):
            average_price = _snapshot_decimal(
                tax_unit_price,
                field=f"{field}.tax_unit_price",
            )
            average_total = average_price * quantity
    values = {
        "库存sku": "\n".join(
            f"{stock_sku} × {purchase_summary._decimal_to_cell_value(item_quantity)}"
            for stock_sku, item_quantity in stock_sku_quantities.items()
        ),
        "产品名称": "\n".join(stock_sku_product_names.values()),
        "来源SP单号": "\n".join(source_sps),
        "库存sku（第一行）": next(iter(stock_sku_quantities)),
        "产品名称（第一行）": next(iter(stock_sku_product_names.values())),
        "型号": model,
        "原价": purchase_summary._decimal_to_cell_value(original_price),
        "均价": (
            purchase_summary._decimal_to_cell_value(average_price)
            if isinstance(average_price, Decimal)
            else ""
        ),
        "厂家": manufacturer,
        "单位": _snapshot_text(line.get("unit"), field=f"{field}.unit"),
        "合同产品名称": _snapshot_text(
            line.get("contract_product_name"),
            field=f"{field}.contract_product_name",
        ),
        purchase_summary.CURRENT_PURCHASE_CONTRACT_HEADER: "",
        purchase_summary.HISTORICAL_INVENTORY_CONTRACT_HEADER: "",
        "税率": _snapshot_text(line.get("tax_rate"), field=f"{field}.tax_rate"),
        "数量": purchase_summary._decimal_to_cell_value(quantity),
        "总价": purchase_summary._decimal_to_cell_value(original_price * quantity),
        "总价（均价）": (
            purchase_summary._decimal_to_cell_value(average_total)
            if isinstance(average_total, Decimal)
            else ""
        ),
    }
    return [values.get(column, "") for column in purchase_summary.MANUFACTURER_COLUMNS]


def generate_purchase_batch_workbooks_from_snapshot(
    snapshot: Mapping[str, Any],
    *,
    gross_margin: Any,
    purchase_output_dir: str | Path | None = None,
    restock_output_dir: str | Path | None = None,
    today: date,
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    if snapshot.get("snapshot_schema") != ARTIFACT_SNAPSHOT_SCHEMA:
        raise erp_purchase_batch.PurchaseBatchClientError(
            "purchase_batch_artifact_snapshot_invalid",
            "ERP 采购文件快照版本不受支持",
            detail={"snapshot_schema": snapshot.get("snapshot_schema")},
        )
    if str(snapshot.get("status") or "") != "current":
        raise erp_purchase_batch.PurchaseBatchClientError(
            "purchase_batch_not_current",
            "采购批次没有当前有效版本，不能重新生成采购文件",
        )
    parsed_gross_margin = restock_workbook._parse_gross_margin(gross_margin)
    raw_sps = _snapshot_list(snapshot.get("sps"), field="sps")
    raw_purchase_lines = _snapshot_list(
        snapshot.get("purchase_lines"),
        field="purchase_lines",
    )
    raw_contracts = _snapshot_list(snapshot.get("contracts"), field="contracts")
    if not raw_sps or not raw_purchase_lines:
        raise erp_purchase_batch.PurchaseBatchClientError(
            "purchase_batch_artifact_snapshot_invalid",
            "ERP 采购文件快照没有 SP 或采购行",
        )

    product_names: dict[tuple[str, str], str] = {}
    request_sps: list[dict[str, Any]] = []
    delivery_nos: list[str] = []
    countries: dict[str, str] = {}
    unmatched_by_sp: dict[str, list[list[Any]]] = {}
    matched_sku_keys: set[str] = set()
    unmatched_sku_keys: set[str] = set()
    restock_matched_sku_count = 0
    restock_unmatched_sku_count = 0
    summary_unmatched_rows: list[list[Any]] = []
    for sp_index, raw_sp in enumerate(raw_sps):
        sp = _snapshot_mapping(raw_sp, field=f"sps[{sp_index}]")
        sp_no = _snapshot_text(sp.get("sp_no"), field=f"sps[{sp_index}].sp_no").upper()
        if sp_no in countries:
            raise erp_purchase_batch.PurchaseBatchClientError(
                "purchase_batch_artifact_snapshot_invalid",
                f"ERP 采购文件快照 SP 重复: {sp_no}",
            )
        delivery_nos.append(sp_no)
        countries[sp_no] = str(sp.get("country") or "").strip()
        planned_lines: list[dict[str, Any]] = []
        for line_index, raw_line in enumerate(
            _snapshot_list(
                sp.get("planned_lines"),
                field=f"sps[{sp_index}].planned_lines",
            )
        ):
            line = _snapshot_mapping(
                raw_line,
                field=f"sps[{sp_index}].planned_lines[{line_index}]",
            )
            stock_sku = _snapshot_text(
                line.get("stock_sku"),
                field=f"sps[{sp_index}].planned_lines[{line_index}].stock_sku",
            ).upper()
            product_name = _snapshot_text(
                line.get("product_name"),
                field=f"sps[{sp_index}].planned_lines[{line_index}].product_name",
            )
            key = (sp_no, stock_sku)
            if key in product_names:
                raise erp_purchase_batch.PurchaseBatchClientError(
                    "purchase_batch_artifact_snapshot_invalid",
                    f"ERP 采购文件快照 SP/SKU 重复: {sp_no}/{stock_sku}",
                )
            product_names[key] = product_name
            matched_sku_keys.add(stock_sku)
            planned_lines.append(dict(line))
        restock_matched_sku_count += len(planned_lines)

        unmatched_rows: list[list[Any]] = []
        for line_index, raw_line in enumerate(
            _snapshot_list(
                sp.get("unmatched_lines"),
                field=f"sps[{sp_index}].unmatched_lines",
            )
        ):
            line = _snapshot_mapping(
                raw_line,
                field=f"sps[{sp_index}].unmatched_lines[{line_index}]",
            )
            stock_sku = _snapshot_text(
                line.get("stock_sku"),
                field=f"sps[{sp_index}].unmatched_lines[{line_index}].stock_sku",
            ).upper()
            product_name = str(line.get("product_name") or "").strip()
            quantity = _snapshot_decimal(
                line.get("planned_shipment_quantity"),
                field=(
                    f"sps[{sp_index}].unmatched_lines[{line_index}]"
                    ".planned_shipment_quantity"
                ),
            )
            issue_message = _snapshot_text(
                line.get("issue_message"),
                field=f"sps[{sp_index}].unmatched_lines[{line_index}].issue_message",
            )
            row = [
                stock_sku,
                product_name,
                sp_no,
                purchase_summary._decimal_to_cell_value(quantity),
                issue_message,
            ]
            unmatched_rows.append(row)
            summary_unmatched_rows.append(row)
            unmatched_sku_keys.add(stock_sku)
        restock_unmatched_sku_count += len(unmatched_rows)
        unmatched_by_sp[sp_no] = unmatched_rows
        request_sps.append({"sp_no": sp_no, "planned_lines": planned_lines})

    purchase_lines: list[dict[str, Any]] = []
    summary_rows: list[list[Any]] = []
    manufacturer_rows: OrderedDict[str, list[list[Any]]] = OrderedDict()
    line_keys: set[tuple[str, str]] = set()
    for line_index, raw_line in enumerate(raw_purchase_lines):
        line = _snapshot_mapping(raw_line, field=f"purchase_lines[{line_index}]")
        manufacturer = _snapshot_text(
            line.get("supplier_name"),
            field=f"purchase_lines[{line_index}].supplier_name",
        )
        model = _snapshot_text(
            line.get("model"),
            field=f"purchase_lines[{line_index}].model",
        )
        line_key = (manufacturer, model.casefold())
        if line_key in line_keys:
            raise erp_purchase_batch.PurchaseBatchClientError(
                "purchase_batch_artifact_snapshot_invalid",
                f"ERP 采购文件快照采购行重复: {manufacturer}/{model}",
            )
        line_keys.add(line_key)
        raw_details = _snapshot_list(
            line.get("allocation_details"),
            field=f"purchase_lines[{line_index}].allocation_details",
        )
        details = [
            _snapshot_mapping(
                detail,
                field=f"purchase_lines[{line_index}].allocation_details[{detail_index}]",
            )
            for detail_index, detail in enumerate(raw_details)
        ]
        row = _snapshot_row(
            line,
            details,
            product_names=product_names,
            field=f"purchase_lines[{line_index}]",
        )
        expected_planned = _snapshot_decimal(
            line.get("planned_shipment_quantity"),
            field=f"purchase_lines[{line_index}].planned_shipment_quantity",
        )
        actual_planned = sum(
            (
                _snapshot_decimal(
                    detail.get("quantity"),
                    field=(
                        f"purchase_lines[{line_index}].allocation_details"
                        f"[{detail_index}].quantity"
                    ),
                )
                for detail_index, detail in enumerate(details)
            ),
            Decimal("0"),
        )
        if actual_planned != expected_planned:
            raise erp_purchase_batch.PurchaseBatchClientError(
                "purchase_batch_artifact_snapshot_invalid",
                "ERP 采购文件快照采购行计划量与来源分配不一致: "
                f"{manufacturer}/{model}",
                detail={
                    "field": f"purchase_lines[{line_index}].allocation_details",
                    "expected": str(expected_planned),
                    "actual": str(actual_planned),
                },
            )
        summary_rows.append(row)
        manufacturer_rows.setdefault(manufacturer, []).append(row)
        purchase_lines.append(dict(line))

    purchase_summary_xlsx = purchase_summary.write_restock_workbook(
        summary_rows,
        manufacturer_rows,
        summary_unmatched_rows,
        delivery_nos=delivery_nos,
        output_dir=purchase_output_dir,
    )
    restock_xlsx_paths: list[str] = []
    restock_outputs: list[dict[str, str]] = []
    for sp_no in delivery_nos:
        restock_rows: list[list[Any]] = []
        for line_index, line in enumerate(purchase_lines):
            details: list[Mapping[str, Any]] = []
            for detail_index, raw_detail in enumerate(
                _snapshot_list(
                    line.get("allocation_details"),
                    field=f"purchase_lines[{line_index}].allocation_details",
                )
            ):
                detail = _snapshot_mapping(
                    raw_detail,
                    field=(
                        f"purchase_lines[{line_index}].allocation_details"
                        f"[{detail_index}]"
                    ),
                )
                if str(detail.get("sp_no") or "").strip().upper() == sp_no:
                    details.append(detail)
            if not details:
                continue
            restock_rows.append(
                _snapshot_row(
                    line,
                    details,
                    product_names=product_names,
                    field=f"purchase_lines[{line_index}]",
                )
            )
        try:
            output_xlsx = restock_workbook.write_fba_restock_workbook(
                restock_rows,
                unmatched_by_sp[sp_no],
                delivery_no=sp_no,
                country=countries[sp_no],
                gross_margin=parsed_gross_margin,
                today=today,
                output_dir=restock_output_dir,
                allow_missing_zhengfei_average=True,
            )
        except Exception as exc:
            setattr(
                exc,
                "generated_artifacts",
                {
                    "purchase_summary_xlsx": str(purchase_summary_xlsx),
                    "restock_xlsx_paths": list(restock_xlsx_paths),
                    "restock_outputs": list(restock_outputs),
                    "delivery_nos": delivery_nos,
                    "gross_margin": str(parsed_gross_margin),
                },
            )
            raise
        restock_xlsx_paths.append(str(output_xlsx))
        restock_outputs.append(
            {"delivery_no": sp_no, "output_xlsx": str(output_xlsx)}
        )

    erp_result = {
        "status": "snapshot",
        "batch_id": snapshot.get("batch_id"),
        "batch_no": snapshot.get("batch_no"),
        "revision_id": snapshot.get("revision_id"),
        "version_no": snapshot.get("version_no"),
        "sp_nos": delivery_nos,
        "contracts": [dict(_snapshot_mapping(item, field="contracts[]")) for item in raw_contracts],
        "purchase_lines": purchase_lines,
    }
    generated = {
        "success": True,
        "delivery_nos": delivery_nos,
        "gross_margin": str(parsed_gross_margin),
        "pricing_basis": restock_workbook.PRICING_BASIS,
        "purchase_summary_xlsx": str(purchase_summary_xlsx),
        "restock_xlsx_paths": restock_xlsx_paths,
        "restock_outputs": restock_outputs,
        "sku_count": len(matched_sku_keys | unmatched_sku_keys),
        "sku_source_count": len(matched_sku_keys),
        "matched_sku_count": len(matched_sku_keys),
        "unmatched_sku_count": len(unmatched_sku_keys),
        "restock_matched_sku_count": restock_matched_sku_count,
        "restock_unmatched_sku_count": restock_unmatched_sku_count,
        "manufacturer_count": len(manufacturer_rows),
        "cross_manufacturer_model_count": restock_workbook._append_cross_manufacturer_model_warning(
            [],
            summary_rows,
        ),
        "warnings": [],
        "source": SOURCE,
    }
    return generated, {"sps": request_sps}, erp_result


def render_formal_purchase_artifacts(
    generated: dict[str, Any],
    erp_result: Mapping[str, Any],
    *,
    request_payload: Mapping[str, Any],
    contract_template_xlsx: str | Path,
    business_date: date,
) -> tuple[dict[str, Any], dict[str, Any]]:
    formal = erp_purchase_batch.apply_formal_erp_result(
        generated,
        erp_result,
        request_payload=request_payload,
    )
    contracts = [
        dict(item)
        for item in list(erp_result.get("contracts") or [])
        if isinstance(item, Mapping)
    ]
    if contracts:
        try:
            contract_result = contract_workbook.fill_formal_purchase_contracts(
                purchase_summary_xlsx=formal["purchase_summary_xlsx"],
                contract_template_xlsx=contract_template_xlsx,
                contracts=contracts,
                purchase_lines=list(erp_result.get("purchase_lines") or []),
                today=business_date,
            )
        except Exception as exc:
            setattr(exc, "formal_artifacts", formal)
            raise
    else:
        contract_result = {
            "success": True,
            "output_files": [],
            "generated_count": 0,
            "warnings": [],
        }
    return formal, contract_result


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
            sku_product_names=purchase_summary.summarize_delivery_product_names(
                csv_paths
            ),
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
                sku_product_names=purchase_summary.summarize_delivery_product_names(
                    [csv_path]
                ),
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
        confirm_unmatched_sku_token = str(
            arguments.get("confirm_unmatched_sku_token") or ""
        ).strip()
        replace_batch_id = str(arguments.get("replace_batch_id") or "").strip()
        expected_version_raw = arguments.get("expected_version_no")
        expected_version_no = int(expected_version_raw) if expected_version_raw not in (None, "") else None
        change_reason = str(arguments.get("change_reason") or "").strip()
        confirmation_arguments_present = any(
            (
                confirm_quote_id,
                confirm_unmatched_sku_token,
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
        expected_unmatched_token = str(
            intent_context.get("confirm_unmatched_sku_token") or ""
        )
        if (
            confirm_unmatched_sku_token != expected_unmatched_token
            and (confirm_unmatched_sku_token or expected_unmatched_token)
        ):
            return {
                **erp_purchase_batch.unmatched_confirmation_result(
                    intent_context,
                    stale=bool(confirm_unmatched_sku_token),
                ),
                "delivery_nos": intent_context["delivery_nos"],
                "master_xlsx": master_xlsx,
                "contract_template_xlsx": contract_template_xlsx,
                "gross_margin": gross_margin,
                "source": SOURCE,
            }
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
                "confirm_unmatched_sku_token": expected_unmatched_token,
                "unmatched_summary": dict(
                    intent_context.get("unmatched_summary") or {}
                ),
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
            formal, contract_result = render_formal_purchase_artifacts(
                generated,
                erp_result,
                request_payload=request_payload,
                contract_template_xlsx=contract_template_xlsx,
                business_date=date.today(),
            )
            return _formal_success_result(
                formal,
                erp_result,
                contract_result,
                intent_context,
            )
        except Exception as exc:
            attached_formal = getattr(exc, "formal_artifacts", None)
            if formal is None and isinstance(attached_formal, dict):
                formal = attached_formal
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
