from __future__ import annotations

import json
import logging
from typing import Any, Mapping

from services.yacang.errors import YacangError, safe_remote_detail


logger = logging.getLogger("services.yacang.export")


def error_fields(exc: Exception) -> dict[str, Any]:
    if isinstance(exc, YacangError):
        return {**exc.diagnostic(), "error_scope": exc.scope}
    return {
        "error_code": type(exc).__name__.upper(),
        "stage": "输入校验" if isinstance(exc, (TypeError, ValueError)) else "执行",
        "http_status": None,
        "error_type": type(exc).__name__,
        "error": safe_remote_detail(exc),
    }


def is_global_error(exc: Exception) -> bool:
    return isinstance(exc, YacangError) and exc.scope == "global"


def failed_export(
    context: Mapping[str, Any],
    exc: Exception,
    *,
    status: str = "failed",
) -> dict[str, Any]:
    result = {**dict(context), "status": status, **error_fields(exc)}
    log_export_result(result)
    return result


def skipped_export(context: Mapping[str, Any], *, reason: str) -> dict[str, Any]:
    result = {
        **dict(context),
        "status": "skipped",
        "stage": "未执行",
        "error_code": "EXPORT_SKIPPED",
        "http_status": None,
        "error_type": "Skipped",
        "error": safe_remote_detail(reason),
    }
    log_export_result(result)
    return result


def successful_export(result: Mapping[str, Any]) -> dict[str, Any]:
    completed = {**dict(result), "status": "success"}
    log_export_result(completed)
    return completed


def summarize_exports(exports: list[dict[str, Any]]) -> dict[str, Any]:
    success_items = [item for item in exports if item.get("status") == "success"]
    failed_items = [item for item in exports if item.get("status") in {"failed", "submit_unknown"}]
    skipped_items = [item for item in exports if item.get("status") == "skipped"]
    if not failed_items and not skipped_items:
        overall = "success"
    elif success_items:
        overall = "partial_success"
    else:
        overall = "failed"
    summary = {
        "success": overall == "success",
        "overall_status": overall,
        "success_count": len(success_items),
        "failed_count": len(failed_items),
        "skipped_count": len(skipped_items),
        "export_count": len(exports),
        "exports": exports,
        "xlsx_paths": [str(item["xlsx_path"]) for item in success_items if item.get("xlsx_path")],
    }
    if failed_items:
        first = failed_items[0]
        summary.update({
            "error_code": first.get("error_code"),
            "stage": first.get("stage"),
            "http_status": first.get("http_status"),
            "error_type": first.get("error_type"),
            "exception": first.get("error"),
        })
    return summary


def log_export_result(result: Mapping[str, Any]) -> None:
    allowed = {
        key: result.get(key)
        for key in (
            "business_type",
            "stage",
            "warehouse",
            "start_date",
            "end_date",
            "as_of_date",
            "http_status",
            "error_code",
            "error_type",
            "status",
        )
        if result.get(key) is not None
    }
    logger.info("yacang_export_event %s", json.dumps(allowed, ensure_ascii=False, separators=(",", ":")))


def cli_failure(
    exc: Exception,
    *,
    business_type: str,
    context: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    fields = error_fields(exc)
    result = {
        "success": False,
        "overall_status": "failed",
        "business_type": business_type,
        **dict(context or {}),
        **fields,
        "exception": fields["error"],
        "exports": [],
        "xlsx_paths": [],
    }
    log_export_result({**result, "status": "failed"})
    return result


__all__ = [
    "cli_failure",
    "failed_export",
    "is_global_error",
    "skipped_export",
    "successful_export",
    "summarize_exports",
]
