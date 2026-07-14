from __future__ import annotations


from services.agent_cli._shared.json_cli import exception_text as _exception_text
from services.mabang.amazon.fba.store_msku_sales_analysis import analyze_store_msku_sales


def run(arguments: dict[str, Any]) -> dict[str, Any]:
    """lxeskill entrypoint — the catalog input_schema is the argument contract."""
    store_name = str(arguments.get("store_name") or "").strip()
    try:
        return analyze_store_msku_sales(store_name).to_payload()
    except Exception as exc:  # noqa: BLE001 — failure context belongs in the payload
        return {
            "success": False,
            "store_name": store_name,
            "exception": _exception_text(exc),
        }
