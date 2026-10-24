from __future__ import annotations

import asyncio
from typing import Any

from services.agent_cli._shared.json_cli import exception_text as _exception_text
from services.mabang.amazon.fba.store_msku_actual_inventory import export_store_msku_actual_inventory
from services.mabang.official_api import diagnostic


def run(arguments: dict[str, Any]) -> dict[str, Any]:
    """lxeskill entrypoint — the catalog input_schema is the argument contract."""
    store_name = str(arguments.get("store_name") or "").strip()
    try:
        kwargs: dict[str, Any] = {}
        if "msku_source_xlsx_path" in arguments:
            kwargs["msku_source_xlsx_path"] = str(arguments["msku_source_xlsx_path"] or "").strip()
        result = asyncio.run(export_store_msku_actual_inventory(store_name, **kwargs))
        return result.to_payload()
    except Exception as exc:  # noqa: BLE001 — failure context belongs in the payload
        return {
            "success": False,
            "store_name": store_name,
            "exception": diagnostic(_exception_text(exc)),
            "auth_refresh_required": False,
        }
