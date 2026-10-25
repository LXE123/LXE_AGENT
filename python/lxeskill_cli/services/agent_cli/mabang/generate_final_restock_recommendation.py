from __future__ import annotations

from typing import Any

from services.agent_cli._shared.json_cli import exception_text as _exception_text
from services.mabang.amazon.fba.final_restock_workbook import generate_final_restock_recommendation


def run(arguments: dict[str, Any]) -> dict[str, Any]:
    """lxeskill entrypoint; arguments are defined by catalog.json."""
    store_name = str(arguments.get("store_name") or "").strip()
    try:
        result = generate_final_restock_recommendation(
            store_name,
            msku_source_xlsx_path=str(arguments.get("msku_source_xlsx_path") or "").strip(),
            shenzhen_inventory_report_xlsx_path=str(
                arguments.get("shenzhen_inventory_report_xlsx_path") or ""
            ).strip(),
            unlinked_shipments_snapshot_path=str(
                arguments.get("unlinked_shipments_snapshot_path") or ""
            ).strip(),
            peak_boost_enabled=arguments.get("peak_boost_enabled", False),
            peak_boost_days=arguments.get("peak_boost_days"),
        )
        return result.to_payload()
    except Exception as exc:  # noqa: BLE001 — business failure includes the real diagnostic.
        return {
            "success": False,
            "store_name": store_name,
            "exception": _exception_text(exc),
        }
