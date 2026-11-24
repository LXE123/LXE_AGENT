"""Create WMS shipments from available ERP carryover, independently per SP."""

from collections import defaultdict
from decimal import Decimal
from pathlib import Path
from typing import Any
from uuid import UUID

from services.commands.mabang import erp_purchase_batch as erp
from services.commands._shared.json_cli import exception_text
from services.commands.mabang import generate_restock_workbook as purchase_summary
from services.commands.mabang.generate_fba_restock_workbook import (
    _delivery_country_metadata,
)
from services.commands.mabang.shipment_quantity_validation import (
    read_delivery_msku_infos,
)


def _build_stock_intent(
    sp_no: str, quote_id: str, *, csv_dir: Path | None = None
) -> dict:
    summary, _, (sp,), (file_name,) = purchase_summary.summarize_delivery_quantities(
        [sp_no], csv_dir=csv_dir
    )
    path = Path(file_name)
    quantities = defaultdict(Decimal)
    for sku, qty in summary.items():
        quantities[sku.strip().upper()] += qty
    components = defaultdict(Decimal)
    infos = read_delivery_msku_infos(path)
    for info in infos.values():
        for sku, qty in info.components.items():
            components[sku.strip().upper()] += qty
    if quantities != components:
        raise erp.PurchaseBatchClientError(
            "purchase_msku_mapping_mismatch", "库存 SKU 计划量与 MSKU 组成不一致"
        )
    country, _ = _delivery_country_metadata(path)
    product_names = purchase_summary.summarize_delivery_product_names([path])
    planned_lines = []
    for sku, quantity in quantities.items():
        line = {
            "stock_sku": sku,
            "planned_shipment_quantity": erp._decimal_text(quantity),
        }
        names = product_names.get(purchase_summary._sku_match_key(sku))
        if names:
            line["product_name"] = "\n".join(names)
        planned_lines.append(line)
    shipment = {
        "sp_no": sp,
        "country": country,
        "delivery_file_name": path.name,
        "delivery_sha256": erp._file_sha256(path),
        "planned_lines": planned_lines,
        "mskus": erp._unit_components(path, tracked_skus=set(quantities), infos=infos),
    }
    payload = {
        "inventory_deduction_mode": "stock_only",
        "shipment": shipment,
        "request_id": f"stock-shipment:{erp._canonical_sha256(shipment)}",
    }
    if quote_id:
        payload["confirm_inventory_quote_id"] = quote_id
    return payload


def _for_sp(sp_no: str, quote_id: str) -> dict[str, Any]:
    payload = _build_stock_intent(sp_no, quote_id)
    status, result = erp.import_purchase_intent(payload)
    sp = payload["shipment"]
    validation_request = {
        **payload,
        "sps": [sp],
        "contracts": result.get("stock_groups"),
    }
    expected = {
        (sp_no, line["stock_sku"]): Decimal(line["planned_shipment_quantity"])
        for line in sp["planned_lines"]
    }
    resolved = {}
    for group in erp._expected_purchase_lines(validation_request).values():
        for key, quantity in group["allocations"].items():
            if key in resolved:
                raise erp.PurchaseBatchClientError(
                    "stock_shipment_mapping_mismatch", "ERP 对同一个库存 SKU 重复分组"
                )
            resolved[key] = quantity
    if expected != resolved:
        raise erp.PurchaseBatchClientError(
            "stock_shipment_mapping_mismatch", "ERP 返回的库存 SKU 或数量与发货单不一致"
        )
    erp.validate_purchase_response(
        status_code=status, response=result, request_payload=validation_request
    )
    if status == 409:
        return {
            "status": result["status"],
            "request_id": payload["request_id"],
            "confirmation": result["confirmation"],
            "error": result["error"],
        }
    return {
        "status": result["status"],
        "request_id": payload["request_id"],
        "batch_id": result["batch_id"],
        "batch_no": result["batch_no"],
        "purchase_lines": result["purchase_lines"],
    }


def run(arguments: dict[str, Any]) -> dict[str, Any]:
    orders = [value.strip().upper() for value in arguments.get("delivery_no", [])]
    if not orders or len(set(orders)) != len(orders):
        return {"success": False, "error": {"code": "invalid_shipments", "message": "请提供不重复的 SP 单号。"}}
    quotes: dict[str, str] = {}
    for item in arguments.get("confirm_quote", []):
        sp, _, value = item.partition("=")
        sp = sp.strip().upper()
        try:
            quote_id = str(UUID(value.strip()))
        except ValueError:
            return {"success": False, "error": {"code": "invalid_quote", "message": "报价格式应为 SP号=报价UUID。"}}
        if sp not in orders or sp in quotes:
            return {"success": False, "error": {"code": "invalid_quote", "message": "报价需对应本次唯一的 SP。"}}
        quotes[sp] = quote_id

    results = []
    for sp in orders:
        try:
            item = _for_sp(sp, quotes.get(sp, ""))
        except (erp.PurchaseBatchClientError, erp.ErpHttpError) as exc:
            item = {"status": "error", "error": erp.client_error_payload(exc)}
        except Exception as exc:
            # A missing or unreadable delivery file must not hide another SP's result.
            item = {"status": "error", "error": {"code": type(exc).__name__, "message": exception_text(exc)}}
        results.append({"sp_no": sp, **item})
    completed = sum(item["status"] in {"created", "idempotent"} for item in results)
    success = all(
        item["status"] in {"created", "idempotent"}
        or (item["status"] == "confirmation_required" and item["sp_no"] not in quotes)
        for item in results
    )
    return {
        "success": success, "created_or_replayed_count": completed, "items": results,
        "message": f"已生成 {completed}/{len(results)} 张发货单，逐单结果见 items。",
    }
