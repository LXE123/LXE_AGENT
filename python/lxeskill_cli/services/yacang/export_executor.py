from __future__ import annotations

from datetime import date
from pathlib import Path
from typing import Any, Mapping, Sequence

from services.yacang.client import YacangClient
from services.yacang.errors import YacangError, safe_remote_detail
from services.yacang.export_workflow import (
    CanonicalExportResult,
    ExportPlan,
    canonical_export_result,
    validate_export_plan,
)
from services.yacang.exports.inbound_listing_time import export_inbound_listing_time
from services.yacang.exports.inventory_month_end import export_inventory_current_snapshot
from services.yacang.exports.sales_source import (
    InventorySalesSourceBatch,
    acquire_inventory_sales_sources,
)
from services.yacang.naming import inventory_sales_filename
from services.yacang.projection import publish_inventory_sales_workbook
from services.yacang.reporting import error_fields, is_global_error
from services.yacang.submission import SubmissionBackend, YacangSubmissionStore
from shared.datasets import dataset_dir


_TASK_STATUSES = frozenset({"not_run", "success", "failed", "skipped"})
_INVENTORY_SALES_DATA_TYPE = "inventory-sales"
_GLOBAL_ERROR_CODES = frozenset({
    "EXPORT_STATUS_UNKNOWN",
    "EXPORT_SUBMIT_UNKNOWN",
    "YACANG_AUTH_EXPIRED",
    "YACANG_CAPTCHA_INVALID",
    "YACANG_CREDENTIALS_MISSING",
    "YACANG_FORBIDDEN",
    "YACANG_NETWORK_ERROR",
    "YACANG_PROD_DISABLED",
    "YACANG_RATE_LIMITED",
    "YACANG_RATE_LIMIT_COOLDOWN",
    "YACANG_REQUEST_GATE_TIMEOUT",
    "YACANG_TOKEN_INVALID",
})


def execute_export_plan(plan: ExportPlan) -> CanonicalExportResult:
    """Execute a frozen ExportPlan without reinterpreting user language."""
    validated = validate_export_plan(plan)
    if validated["requires_clarification"]:
        raise ValueError("需要澄清的 ExportPlan 不得进入 executor")

    logical_tasks = [dict(task) for task in validated["logical_tasks"]]
    diagnostics = [dict(item) for item in validated["diagnostics"]]
    artifacts: list[dict[str, Any]] = []
    task_results: list[dict[str, Any]] = []
    inventory_sales_successes: list[tuple[int, dict[str, Any], dict[str, Any]]] = []
    output_dir = dataset_dir("yacang_exports")
    client = YacangClient()
    submission_store = YacangSubmissionStore()

    source_batch: InventorySalesSourceBatch | None = None
    source_error: Exception | None = None
    unique_fetches = _unique_source_fetches(validated["source_fetches"])
    if unique_fetches:
        try:
            source_batch = acquire_inventory_sales_sources(
                unique_fetches,
                output_dir=output_dir,
                client=client,
                submission_store=submission_store,
            )
        except Exception as exc:  # noqa: BLE001 - converted to sanitized canonical diagnostics
            source_error = exc

    stopped = False
    for task in logical_tasks:
        if stopped:
            result, diagnostic = _skipped_task(task, reason="前序全局错误，未继续执行")
            task_results.append(result)
            diagnostics.append(diagnostic)
            continue

        if task.get("status") == "failed" or task.get("error_code"):
            task_results.append(_preflight_failed_task(task))
            continue

        if str(task.get("data_type")) == _INVENTORY_SALES_DATA_TYPE and source_error is not None:
            result, diagnostic = _failed_task(task, source_error)
            task_results.append(result)
            diagnostics.append(diagnostic)
            if is_global_error(source_error) or _is_global_diagnostic(diagnostic):
                stopped = True
            continue

        if str(task.get("data_type")) == _INVENTORY_SALES_DATA_TYPE:
            try:
                result, source, diagnostic = _consume_inventory_sales_source(task, source_batch)
            except Exception as exc:  # noqa: BLE001 - converted to sanitized canonical diagnostics
                result, diagnostic = _failed_task(task, exc)
                source = None
            task_results.append(result)
            if source is not None:
                inventory_sales_successes.append((len(task_results) - 1, task, source))
            if diagnostic is not None:
                diagnostics.append(diagnostic)
                if _is_global_diagnostic(diagnostic):
                    stopped = True
            continue

        try:
            summary = _execute_logical_task(
                task,
                source_batch=source_batch,
                execution_date=validated["execution_date"],
                output_dir=output_dir,
                client=client,
                submission_store=submission_store,
            )
            result, artifact, diagnostic = _consume_task_summary(task, summary)
        except Exception as exc:  # noqa: BLE001 - converted to sanitized canonical diagnostics
            result, diagnostic = _failed_task(task, exc)
            artifact = None

        task_results.append(result)
        if artifact is not None:
            artifacts.append(artifact)
        if diagnostic is not None:
            diagnostics.append(diagnostic)
            if _is_global_diagnostic(diagnostic):
                stopped = True

    if inventory_sales_successes:
        try:
            artifact = _publish_inventory_sales_artifact(
                inventory_sales_successes,
                task_results=task_results,
                output_dir=output_dir,
                execution_date=validated["execution_date"],
            )
            artifacts.insert(0, artifact)
        except Exception as exc:  # noqa: BLE001 - local publication failure stays diagnosable
            for task_index, task, _source in inventory_sales_successes:
                failed_result, diagnostic = _failed_task(task, exc)
                task_results[task_index] = failed_result
                diagnostics.append(diagnostic)

    return canonical_export_result(
        overall_status=_overall_status(task_results, diagnostics),
        tasks=task_results,
        artifacts=artifacts,
        questions=validated["questions"],
        diagnostics=diagnostics,
    )


def _unique_source_fetches(source_fetches: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    unique: dict[str, dict[str, Any]] = {}
    for fetch in source_fetches:
        fetch_id = str(fetch.get("source_fetch_id") or "").strip()
        if not fetch_id:
            raise ValueError("source_fetch 缺少 source_fetch_id")
        current = dict(fetch)
        previous = unique.setdefault(fetch_id, current)
        if previous != current:
            raise ValueError(f"source_fetch_id 存在冲突定义: {fetch_id}")
    return list(unique.values())


def _execute_logical_task(
    task: Mapping[str, Any],
    *,
    source_batch: InventorySalesSourceBatch | None,
    execution_date: str,
    output_dir: Path,
    client: YacangClient,
    submission_store: SubmissionBackend,
) -> Mapping[str, Any]:
    data_type = str(task.get("data_type") or "")
    warehouse = str(task.get("warehouse") or "").strip()
    if data_type == "inventory-current-snapshot":
        execution_day = date.fromisoformat(execution_date)
        return export_inventory_current_snapshot(
            as_of_date=execution_date,
            warehouse=warehouse,
            output_dir=output_dir,
            today=lambda: execution_day,
            client=client,
            submission_store=submission_store,
        )
    if data_type == "inbound-listing-time":
        execution_day = date.fromisoformat(execution_date)
        return export_inbound_listing_time(
            as_of_date=execution_date,
            output_dir=output_dir,
            today=lambda: execution_day,
            client=client,
            submission_store=submission_store,
        )
    raise ValueError(f"不支持的雅仓逻辑任务类型: {data_type}")


def _consume_inventory_sales_source(
    task: Mapping[str, Any],
    source_batch: InventorySalesSourceBatch | None,
) -> tuple[dict[str, Any], dict[str, Any] | None, dict[str, Any] | None]:
    if source_batch is None:
        raise YacangError(
            "执行库存动销任务",
            "缺少共享物理库存动销源",
            code="EXPORT_STATUS_UNKNOWN",
            scope="global",
        )
    warehouse = str(task.get("warehouse") or "").strip()
    source = next(
        (dict(item) for item in source_batch.results if str(item.get("warehouse") or "") == warehouse),
        None,
    )
    if source is None:
        raise YacangError(
            "执行库存动销任务",
            f"共享物理源缺少仓库 {warehouse}",
            code="YACANG_RESULT_INVALID",
        )
    raw_status = str(source.get("status") or "failed")
    status = raw_status if raw_status in _TASK_STATUSES else "failed"
    if status == "success":
        xlsx_path = str(source.get("xlsx_path") or "").strip()
        if not xlsx_path:
            raise YacangError(
                "执行库存动销任务",
                "成功物理源缺少已验证的 XLSX 路径",
                code="YACANG_RESULT_INVALID",
            )
        return _task_result(task, status="success"), source, None
    code = str(source.get("error_code") or "YACANG_EXPORT_FAILED")
    diagnostic = _diagnostic_from_fields(task, source, code=code)
    return _task_result(task, status=status, diagnostic_codes=[code]), None, diagnostic


def _publish_inventory_sales_artifact(
    successes: Sequence[tuple[int, Mapping[str, Any], Mapping[str, Any]]],
    *,
    task_results: list[dict[str, Any]],
    output_dir: Path,
    execution_date: str,
) -> dict[str, Any]:
    warehouse_codes = [str(task["warehouse"]) for _index, task, _source in successes]
    path = output_dir / inventory_sales_filename(warehouse_codes, file_date=execution_date)
    row_count = publish_inventory_sales_workbook(
        [
            (str(task["warehouse"]), Path(str(source["xlsx_path"])))
            for _index, task, source in successes
        ],
        path,
    )
    artifact_id = "artifact:inventory-sales"
    task_ids = [str(task["task_id"]) for _index, task, _source in successes]
    for task_index, _task, _source in successes:
        task_results[task_index]["artifact_ids"] = [artifact_id]
    return {
        "artifact_id": artifact_id,
        "task_id": task_ids[0],
        "task_ids": task_ids,
        "data_type": _INVENTORY_SALES_DATA_TYPE,
        "path": str(path),
        "filename": path.name,
        **({"warehouse": warehouse_codes[0]} if len(warehouse_codes) == 1 else {}),
        "warehouses": warehouse_codes,
        "row_count": row_count,
        "source": "yacang",
    }


def _consume_task_summary(
    task: Mapping[str, Any],
    summary: Mapping[str, Any],
) -> tuple[dict[str, Any], dict[str, Any] | None, dict[str, Any] | None]:
    exports = summary.get("exports")
    if not isinstance(exports, Sequence) or isinstance(exports, (str, bytes)) or len(exports) != 1:
        raise YacangError(
            "汇总导出结果",
            "单个逻辑任务必须返回且只返回一个结果",
            code="YACANG_RESULT_INVALID",
        )
    export = exports[0]
    if not isinstance(export, Mapping):
        raise YacangError("汇总导出结果", "逻辑任务结果必须是对象", code="YACANG_RESULT_INVALID")

    raw_status = str(export.get("status") or "failed")
    status = raw_status if raw_status in _TASK_STATUSES else "failed"
    if status == "success":
        xlsx_path = str(export.get("xlsx_path") or "").strip()
        if not xlsx_path:
            raise YacangError(
                "汇总导出结果",
                "成功任务缺少已验证的 XLSX 路径",
                code="YACANG_RESULT_INVALID",
            )
        artifact_id = f"artifact:{task['task_id']}"
        artifact = {
            "artifact_id": artifact_id,
            "task_id": str(task["task_id"]),
            "data_type": str(task["data_type"]),
            "path": xlsx_path,
            "filename": str(export.get("output_filename") or Path(xlsx_path).name),
            **({"warehouse": task.get("warehouse")} if task.get("warehouse") else {}),
            **({"row_count": export.get("row_count")} if export.get("row_count") is not None else {}),
            **({"source": export.get("source")} if export.get("source") is not None else {}),
        }
        return _task_result(task, status="success", artifact_ids=[artifact_id]), artifact, None

    code = str(export.get("error_code") or "YACANG_EXPORT_FAILED")
    diagnostic = _diagnostic_from_fields(task, export, code=code)
    return _task_result(task, status=status, diagnostic_codes=[code]), None, diagnostic


def _preflight_failed_task(task: Mapping[str, Any]) -> dict[str, Any]:
    code = str(task.get("error_code") or "YACANG_PREFLIGHT_FAILED")
    return _task_result(task, status="failed", diagnostic_codes=[code])


def _failed_task(
    task: Mapping[str, Any],
    exc: Exception,
) -> tuple[dict[str, Any], dict[str, Any]]:
    fields = error_fields(exc)
    code = str(fields.get("error_code") or type(exc).__name__.upper())
    diagnostic = _diagnostic_from_fields(task, fields, code=code)
    return _task_result(task, status="failed", diagnostic_codes=[code]), diagnostic


def _skipped_task(
    task: Mapping[str, Any],
    *,
    reason: str,
) -> tuple[dict[str, Any], dict[str, Any]]:
    code = "EXPORT_SKIPPED"
    diagnostic = {
        "kind": "execution",
        "code": code,
        "message": safe_remote_detail(reason),
        "task_id": str(task["task_id"]),
        **({"warehouse": task.get("warehouse")} if task.get("warehouse") else {}),
    }
    return _task_result(task, status="skipped", diagnostic_codes=[code]), diagnostic


def _task_result(
    task: Mapping[str, Any],
    *,
    status: str,
    artifact_ids: Sequence[str] = (),
    diagnostic_codes: Sequence[str] = (),
) -> dict[str, Any]:
    if status not in _TASK_STATUSES:
        raise ValueError(f"无效的雅仓任务状态: {status}")
    return {
        "task_id": str(task["task_id"]),
        "data_type": str(task["data_type"]),
        "scope": str(task["scope"]),
        "warehouse": task.get("warehouse"),
        "status": status,
        "source_fetch_id": task.get("source_fetch_id"),
        "effective_parameters": dict(task.get("effective_parameters") or {}),
        "artifact_ids": list(artifact_ids),
        "diagnostic_codes": list(diagnostic_codes),
    }


def _diagnostic_from_fields(
    task: Mapping[str, Any],
    fields: Mapping[str, Any],
    *,
    code: str,
) -> dict[str, Any]:
    diagnostic = {
        "kind": "execution",
        "code": code,
        "message": safe_remote_detail(fields.get("error") or fields.get("message") or code),
        "task_id": str(task["task_id"]),
        **({"warehouse": task.get("warehouse")} if task.get("warehouse") else {}),
    }
    for source, target in (
        ("stage", "stage"),
        ("http_status", "http_status"),
        ("error_type", "error_type"),
        ("error_scope", "error_scope"),
    ):
        if fields.get(source) is not None:
            diagnostic[target] = fields.get(source)
    return diagnostic


def _is_global_code(code: Any) -> bool:
    return str(code or "") in _GLOBAL_ERROR_CODES


def _is_global_diagnostic(diagnostic: Mapping[str, Any]) -> bool:
    return diagnostic.get("error_scope") == "global" or _is_global_code(diagnostic.get("code"))


def _overall_status(
    tasks: Sequence[Mapping[str, Any]],
    diagnostics: Sequence[Mapping[str, Any]],
) -> str:
    has_success = any(task.get("status") == "success" for task in tasks)
    has_task_failure = any(task.get("status") in {"failed", "skipped", "not_run"} for task in tasks)
    has_unsupported = any(item.get("kind") == "unsupported" for item in diagnostics)
    if has_success and not has_task_failure and not has_unsupported:
        return "success"
    if has_success:
        return "partial_success"
    return "failed"


__all__ = ["execute_export_plan"]
