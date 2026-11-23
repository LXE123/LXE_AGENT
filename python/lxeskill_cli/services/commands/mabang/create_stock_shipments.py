"""Create WMS shipments from available ERP carryover, independently per SP."""
from typing import Any
from uuid import UUID

from services.commands.mabang import erp_purchase_batch as erp
from services.commands._shared.json_cli import exception_text


def _for_sp(sp_no: str, master: str, quote_id: str) -> dict[str, Any]:
    payload, _ = erp.build_purchase_intent(
        [sp_no], master_xlsx=master, inventory_deduction_mode="stock_only",
        confirm_inventory_quote_id=quote_id,
    )
    status, result = erp.import_purchase_intent(payload)
    erp.validate_purchase_response(status_code=status, response=result, request_payload=payload)
    if status == 409:
        return {
            "status": result["status"], "request_id": payload["request_id"],
            "confirmation": result["confirmation"], "error": result["error"],
        }
    return {
        "status": result["status"], "request_id": payload["request_id"],
        "batch_id": result["batch_id"], "batch_no": result["batch_no"],
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
            item = _for_sp(sp, arguments.get("master_xlsx", ""), quotes.get(sp, ""))
        except (erp.PurchaseBatchClientError, erp.ErpHttpError) as exc:
            item = {"status": "error", "error": erp.client_error_payload(exc)}
        except Exception as exc:
            # A missing or unreadable delivery file must not hide another SP's result.
            item = {"status": "error", "error": {"code": type(exc).__name__, "message": exception_text(exc)}}
        results.append({"sp_no": sp, **item})
    completed = sum(item["status"] in {"created", "idempotent"} for item in results)
    # Fetching a quote is a successful first step and allows the CLI to
    # remember the uploaded master workbook for the confirmation call.
    success = all(
        item["status"] in {"created", "idempotent"}
        or (item["status"] == "confirmation_required" and item["sp_no"] not in quotes)
        for item in results
    )
    return {
        "success": success, "created_or_replayed_count": completed, "items": results,
        "message": f"已生成 {completed}/{len(results)} 张发货单，逐单结果见 items。",
    }
