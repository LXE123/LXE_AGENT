from __future__ import annotations


from services.agent_cli._shared.json_cli import exception_text as _exception_text
from services.mabang.amazon.fba.store_msku_replenishment import calculate_store_msku_replenishment


def run(arguments: dict[str, Any]) -> dict[str, Any]:
    """lxeskill entrypoint — the catalog input_schema is the argument contract."""
    store_name = str(arguments.get("store_name") or "").strip()
    try:
        result = calculate_store_msku_replenishment(
            store_name,
            template_name=str(arguments.get("template") or "").strip() or None,
            unlinked_shipments_snapshot_path=str(arguments.get("unlinked_shipments_snapshot") or "").strip() or None,
            amazon_restock_inventory_snapshot_path=str(arguments.get("amazon_restock_inventory_snapshot") or "").strip() or None,
            amazon_fba_inventory_snapshot_path=str(arguments.get("amazon_fba_inventory_snapshot") or "").strip() or None,
        )
        return result.to_payload()
    except Exception as exc:  # noqa: BLE001 — failure context belongs in the payload
        return {
            "success": False,
            "store_name": store_name,
            "exception": _exception_text(exc),
        }
