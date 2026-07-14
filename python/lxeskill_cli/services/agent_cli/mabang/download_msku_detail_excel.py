from __future__ import annotations

import asyncio
from typing import Any

from services.agent_cli._shared.json_cli import exception_text as _exception_text
from services.mabang.amazon.fba.msku_detail import download_msku_detail_excel, normalize_ship_no


def run(arguments: dict[str, Any]) -> dict[str, Any]:
    """lxeskill entrypoint — the catalog input_schema is the argument contract."""
    ship_no = ""
    try:
        raw_ship = normalize_ship_no(str(arguments.get("ship_no") or ""))
        raw_delivery = normalize_ship_no(str(arguments.get("delivery_no") or ""))
        ship_no = raw_delivery or raw_ship
        if raw_ship and raw_delivery and raw_ship != raw_delivery:
            raise ValueError(
                f"ship_no 和 delivery_no 不一致: ship_no={raw_ship}, delivery_no={raw_delivery}"
            )
        result = asyncio.run(download_msku_detail_excel(ship_no))
        return result.to_payload()
    except Exception as exc:  # noqa: BLE001 — failure context belongs in the payload
        return {
            "success": False,
            "ship_no": ship_no,
            "exception": _exception_text(exc),
        }
