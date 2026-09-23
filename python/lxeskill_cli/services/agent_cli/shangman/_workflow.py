from __future__ import annotations

import os
from typing import Any

from services.shangman.goods_export import run as export_goods
from services.shangman.intent import COUNTRY, OPERATION, PLATFORM, build_goods_export_plan


def preview(arguments: dict[str, Any]) -> dict[str, Any]:
    plan = build_goods_export_plan(arguments.get("params"))
    return {"success": plan["status"] == "ready", **plan}


def _projection(*, row_count: Any = None, code: str | None = None, message: str | None = None) -> dict[str, Any]:
    data: dict[str, Any] = {"platform": PLATFORM, "country": COUNTRY, "business_type": OPERATION}
    if isinstance(row_count, int) and not isinstance(row_count, bool):
        data["row_count"] = row_count
    result: dict[str, Any] = {"data": data}
    if code and message:
        result["error"] = {"code": code, "message": message}
    return {"terminal_projection": result}


def _failure(plan: dict[str, Any], code: str, message: str, *, status: str = "failed") -> dict[str, Any]:
    return {
        "success": False, "status": status, "params": plan.get("params"),
        "intent": plan.get("intent"), "plan": plan.get("plan"),
        "error": {"code": code, "message": message}, **_projection(code=code, message=message),
    }

def run(arguments: dict[str, Any]) -> dict[str, Any]:
    plan = build_goods_export_plan(arguments.get("params"))
    if plan["status"] != "ready":
        error = dict(plan.get("error") or {})
        return _failure(plan, str(error.get("code") or "params_invalid"), str(error.get("message") or "invalid Shangman export parameters"))
    if str(os.getenv("LXE_SHANGMAN_PROD_ENABLED", "")).lower() != "true":
        return _failure(plan, "production_gate_required", "LXE_SHANGMAN_PROD_ENABLED must be true before ERP execution", status="blocked")
    result = export_goods({})
    if not result.get("success"):
        error = dict(result.get("error") or {})
        return _failure(plan, str(error.get("code") or "erp_execution_failed"), str(error.get("message") or "Shangman export failed"))
    return {
        "success": True, "status": "completed", "params": plan["params"], "intent": plan["intent"], "plan": plan["plan"],
        **result, **_projection(row_count=result.get("row_count")),
    }


__all__ = ["preview", "run"]
