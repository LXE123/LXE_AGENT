from __future__ import annotations

from typing import Any, Mapping

from services.agent_cli.yacang._shared import reject_unknown_arguments
from services.yacang.export_workflow import run_export_workflow
from services.yacang.export_workflow import canonical_export_result
from services.yacang.reporting import cli_failure


def run(arguments: dict[str, Any]) -> dict[str, Any]:
    """Run the structured Yacang workflow and expose only its terminal summary."""
    try:
        reject_unknown_arguments(
            arguments,
            {
                "request_text",
                "data_type_intent",
                "warehouse_intent",
                "created_date_filter",
                "inventory_snapshot_intent",
            },
        )
        raw_request_text = arguments.get("request_text")
        request_text = str(raw_request_text).strip() if raw_request_text else None
        result = run_export_workflow(
            request_text,
            data_type_intent=arguments.get("data_type_intent"),
            warehouse_intent=arguments.get("warehouse_intent"),
            created_date_filter=arguments.get("created_date_filter"),
            inventory_snapshot_intent=arguments.get("inventory_snapshot_intent"),
        )
        return _public_result(result)
    except Exception as exc:  # noqa: BLE001 - real sanitized failure is the command result
        failure = cli_failure(
            exc,
            business_type="yacang-export-workflow",
            context={"request_text_present": bool(arguments.get("request_text"))},
        )
        result = canonical_export_result(
            overall_status="failed",
            diagnostics=[
                {
                    "kind": "invalid" if failure["stage"] == "输入校验" else "error",
                    "code": str(failure["error_code"]),
                    "message": str(failure["exception"]),
                }
            ],
        )
        return _public_result(
            result,
            error={"code": str(failure["error_code"]), "message": str(failure["exception"])},
        )


def _public_result(
    result: Mapping[str, Any],
    *,
    error: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    status = str(result.get("overall_status") or "failed")
    return {
        "success": status == "success",
        **dict(result),
        "terminal_projection": _terminal_projection(result, error=error),
    }


def _terminal_projection(
    result: Mapping[str, Any],
    *,
    error: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    status = str(result.get("overall_status") or "failed")
    data: dict[str, Any] = {
        "platform": "yacang",
        "business_type": "export",
        "status": status,
        "partial": status == "partial_success",
        "file_count": len(_records(result.get("artifacts"))),
    }
    if status == "needs_clarification":
        data["questions"] = _records(result.get("questions"))
    elif status in {"partial_success", "failed"}:
        data["failed_tasks"] = _failed_task_summaries(result)

    projection: dict[str, Any] = {"data": data}
    projection_error = dict(error) if error is not None else _terminal_error(result)
    if projection_error is not None:
        projection["error"] = projection_error
    return projection


def _failed_task_summaries(result: Mapping[str, Any]) -> list[dict[str, Any]]:
    diagnostics_by_task: dict[str, list[str]] = {}
    for diagnostic in _records(result.get("diagnostics")):
        task_id = str(diagnostic.get("task_id") or "").strip()
        code = str(diagnostic.get("code") or "").strip()
        if task_id and code:
            diagnostics_by_task.setdefault(task_id, []).append(code)

    summaries: list[dict[str, Any]] = []
    for task in _records(result.get("tasks")):
        status = str(task.get("status") or "")
        if status not in {"failed", "skipped", "not_run"}:
            continue
        task_id = str(task.get("task_id") or "")
        diagnostic_codes = [
            str(code).strip()
            for code in list(task.get("diagnostic_codes") or [])
            if str(code).strip()
        ]
        if not diagnostic_codes:
            diagnostic_codes = diagnostics_by_task.get(task_id, [])
        fallback_code = {
            "skipped": "EXPORT_SKIPPED",
            "not_run": "EXPORT_NOT_RUN",
        }.get(status, "YACANG_EXPORT_FAILED")
        summaries.append({
            "task_id": task_id,
            "data_type": task.get("data_type"),
            "warehouse": task.get("warehouse") or task.get("warehouse_scope"),
            "status": status,
            "error_code": diagnostic_codes[0] if diagnostic_codes else fallback_code,
        })
    return summaries


def _terminal_error(result: Mapping[str, Any]) -> dict[str, str] | None:
    status = str(result.get("overall_status") or "failed")
    if status == "success":
        return None
    if status == "partial_success":
        return {
            "code": "yacang_partial_success",
            "message": "雅仓导出部分任务成功，部分任务失败",
        }
    if status == "needs_clarification":
        return {
            "code": "yacang_needs_clarification",
            "message": "雅仓导出需要澄清业务意图",
        }
    diagnostics = _records(result.get("diagnostics"))
    first = diagnostics[0] if diagnostics else {}
    return {
        "code": str(first.get("code") or "yacang_export_failed"),
        "message": str(first.get("message") or "雅仓导出失败"),
    }


def _records(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    return [dict(item) for item in value if isinstance(item, Mapping)]


__all__ = ["run"]
