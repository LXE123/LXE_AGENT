from __future__ import annotations

import asyncio
from typing import Any

from services.agent_cli._shared.json_cli import exception_text as _exception_text
from services.mabang.amazon.fba.store_msku import download_store_msku_excel


def run(arguments: dict[str, Any]) -> dict[str, Any]:
    """lxeskill entrypoint — the catalog input_schema is the argument contract."""
    store_name = str(arguments.get("store_name") or "").strip()
    store_id = str(arguments.get("store_id") or "").strip()
    id_type = str(arguments.get("id_type") or "").strip()
    try:
        result = asyncio.run(download_store_msku_excel(store_id, id_type, store_name=store_name))
        return result.to_payload()
    except Exception as exc:  # noqa: BLE001 — failure context belongs in the payload
        return {
            "success": False,
            "store_name": store_name,
            "store_id": store_id,
            "id_type": id_type,
            "exception": _exception_text(exc),
        }
