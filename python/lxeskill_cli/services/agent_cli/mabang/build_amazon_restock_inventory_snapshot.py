from __future__ import annotations


from services.agent_cli._shared.json_cli import exception_text as _exception_text
from services.mabang.amazon.fba.amazon_restock_inventory import (
    build_amazon_restock_inventory_snapshot,
    normalize_store_name,
)


def run(arguments: dict[str, Any]) -> dict[str, Any]:
    """lxeskill entrypoint — the catalog input_schema is the argument contract."""
    store_name = ""
    try:
        store_name = normalize_store_name(arguments.get("store_name") or "")
        csv_path = str(arguments.get("csv") or "").strip()
        if not csv_path:
            raise ValueError("csv 不能为空")
        result = build_amazon_restock_inventory_snapshot(
            csv_path,
            store_name=store_name,
            output_dir=str(arguments.get("output_dir") or "").strip() or None,
            msku_xlsx_path=str(arguments.get("msku_xlsx") or "").strip() or None,
            msku_dir=str(arguments.get("msku_dir") or "").strip() or None,
        )
        return result.to_payload()
    except Exception as exc:  # noqa: BLE001 — failure context belongs in the payload
        return {
            "success": False,
            "store_name": store_name,
            "exception": _exception_text(exc),
        }
