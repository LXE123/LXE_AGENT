from __future__ import annotations

import asyncio
from typing import Any

from services.agent_cli._shared.json_cli import exception_text as _exception_text
from services.mabang.brazil_overseas.workflow import export_brazil_overseas


def _terminal_projection(*, export_kind: str, error: dict[str, str] | None = None) -> dict[str, Any]:
    projection: dict[str, Any] = {
        "data": {
            "platform": "mabang",
            "business_type": "brazil_overseas_export",
            "export_kind": export_kind,
        },
    }
    if error is not None:
        projection["error"] = error
    return projection


def run(arguments: dict[str, Any]) -> dict[str, Any]:
    """Run one export using parameters resolved by the model."""
    warehouse = str(arguments.get("warehouse") or "").strip()
    export_kind = str(arguments.get("export_kind") or "").strip()
    if not warehouse or not export_kind:
        payload = {
            "success": False,
            "warehouse": warehouse,
            "export_kind": export_kind,
            "exception": "warehouse 和 export_kind 不能为空",
            "auth_refresh_required": False,
        }
        return {**payload, "terminal_projection": _terminal_projection(
            export_kind=export_kind,
            error={"code": "mabang_brazil_overseas_invalid", "message": payload["exception"]},
        )}
    try:
        result = asyncio.run(export_brazil_overseas(warehouse=warehouse, export_kind=export_kind))
        return {**result.to_payload(), "terminal_projection": _terminal_projection(export_kind=export_kind)}
    except Exception as exc:  # noqa: BLE001 — failure context belongs in the payload
        payload = {
            "success": False,
            "warehouse": warehouse,
            "export_kind": export_kind,
            "exception": _exception_text(exc),
            "auth_refresh_required": False,
        }
        return {**payload, "terminal_projection": _terminal_projection(
            export_kind=export_kind,
            error={"code": "mabang_brazil_overseas_failed", "message": payload["exception"]},
        )}
