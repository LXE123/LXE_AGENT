from __future__ import annotations

from datetime import date
from typing import Any

from services.agent_cli.yacang._shared import reject_unknown_arguments
from services.yacang.export_intent import normalize_export_intent
from services.yacang.export_workflow import plan_export_workflow
from services.yacang.reporting import cli_failure


def run(arguments: dict[str, Any]) -> dict[str, Any]:
    """Build a deterministic Yacang plan without invoking the executor."""
    try:
        reject_unknown_arguments(arguments, {"request_text"})
        request_text = str(arguments.get("request_text") or "").strip()
        if not request_text:
            raise ValueError("request_text 不能为空")
        execution_day = date.today()
        normalized = normalize_export_intent(request_text, today=lambda: execution_day)
        plan = plan_export_workflow(normalized, execution_date=execution_day.isoformat())
        return {"success": not plan["requires_clarification"], "plan": plan}
    except Exception as exc:  # noqa: BLE001 - real sanitized failure is the command result
        return cli_failure(
            exc,
            business_type="yacang-export-preview",
            context={"request_text_present": bool(arguments.get("request_text"))},
        )


__all__ = ["run"]
