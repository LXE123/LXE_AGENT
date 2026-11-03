from __future__ import annotations

from typing import Any

from services.commands._shared.json_cli import exception_text as _exception_text
from services.mabang.amazon.fba.replenishment_inputs import load_replenishment_inputs
from services.mabang.amazon.fba.replenishment_v2_workbook import generate_replenishment_v2
from services.mabang.amazon.fba.store_msku_replenishment import calculate_store_msku_replenishment


def run(arguments: dict[str, Any]) -> dict[str, Any]:
    """lxeskill entrypoint — the catalog input_schema is the argument contract."""
    store_name = str(arguments.get("store_name") or "").strip()
    version = arguments.get("version")
    try:
        if version not in {"v1", "v2"}:
            raise ValueError("version 必须为 v1 或 v2")
        v1_options = {"template", "amazon_restock_inventory_snapshot", "amazon_fba_inventory_snapshot"}
        v2_options = {"peak_boost_enabled", "peak_boost_days"}
        unexpected = (v2_options if version == "v1" else v1_options) & arguments.keys()
        if unexpected:
            raise ValueError(f"{version} 不支持参数: {', '.join(sorted(unexpected))}")
        inputs = load_replenishment_inputs(
            store_name,
            **{name: str(arguments.get(name) or "").strip() for name in (
                "msku_source_xlsx_path", "shenzhen_inventory_report_xlsx_path", "unlinked_shipments_snapshot_path",
            )},
        )
        if version == "v1":
            result = calculate_store_msku_replenishment(
                inputs, template_name=arguments.get("template"),
                amazon_restock_inventory_snapshot_path=arguments.get("amazon_restock_inventory_snapshot"),
                amazon_fba_inventory_snapshot_path=arguments.get("amazon_fba_inventory_snapshot"),
            )
        else:
            result = generate_replenishment_v2(
                inputs, peak_boost_enabled=arguments.get("peak_boost_enabled"),
                peak_boost_days=arguments.get("peak_boost_days"),
            )
        return result.to_payload()
    except Exception as exc:  # noqa: BLE001 — failure context belongs in the payload
        return {
            "success": False,
            "store_name": store_name,
            "version": version,
            "exception": _exception_text(exc),
        }
