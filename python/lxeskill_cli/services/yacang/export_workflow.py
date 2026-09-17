from __future__ import annotations

from datetime import date
from typing import Any, Callable, Mapping, NotRequired, Sequence, TypedDict

from services.yacang.export_intent import (
    ALL_DATA_TYPES as CANONICAL_DATA_TYPES,
    WAREHOUSE_CODES,
    normalize_export_intent,
)
from services.yacang.exports.sales_source import resolve_source_date_range, sales_source_fetch_id


_INVENTORY_SALES_DATA_TYPE = "inventory-sales"
_INVENTORY_DATA_TYPE = "inventory-current-snapshot"
_INBOUND_DATA_TYPE = "inbound-listing-time"
EXPORT_PLAN_SCHEMA_VERSION = "1"
CANONICAL_RESULT_STATUSES = frozenset({
    "success",
    "partial_success",
    "failed",
    "needs_clarification",
})

ALL_DATA_TYPES = CANONICAL_DATA_TYPES


class ExportQuestion(TypedDict, total=False):
    code: str
    field: str
    message: str
    options: list[str]


class ExportDiagnostic(TypedDict, total=False):
    kind: str
    code: str
    message: str
    field: str
    requested_value: dict[str, Any]
    task_id: str


class LogicalTask(TypedDict):
    task_id: str
    data_type: str
    scope: str
    status: str
    effective_parameters: dict[str, Any]
    warehouse: NotRequired[str]
    warehouse_scope: NotRequired[str]
    snapshot: NotRequired[str]
    source_fetch_id: NotRequired[str]
    error_code: NotRequired[str]


class SourceFetch(TypedDict):
    source_fetch_id: str
    source_type: str
    warehouse: str
    status: str
    effective_parameters: dict[str, Any]


class ExportPlan(TypedDict):
    schema_version: str
    execution_date: str
    requires_clarification: bool
    questions: list[ExportQuestion]
    diagnostics: list[ExportDiagnostic]
    logical_tasks: list[LogicalTask]
    source_fetches: list[SourceFetch]


class CanonicalExportResult(TypedDict):
    schema_version: str
    overall_status: str
    tasks: list[dict[str, Any]]
    artifacts: list[dict[str, Any]]
    questions: list[ExportQuestion]
    diagnostics: list[ExportDiagnostic]


ExportPlanExecutor = Callable[[ExportPlan], CanonicalExportResult]


def plan_export_workflow(
    normalized: Mapping[str, Any],
    *,
    execution_date: str,
) -> ExportPlan:
    """Build a side-effect-free execution plan from a completed intent contract."""
    execution_day = date.fromisoformat(str(execution_date).strip()).isoformat()
    questions = _records(normalized.get("questions"))
    diagnostics = _records(normalized.get("preflight_issues"))
    base: ExportPlan = {
        "schema_version": EXPORT_PLAN_SCHEMA_VERSION,
        "execution_date": execution_day,
        "requires_clarification": bool(normalized.get("requires_clarification")),
        "questions": questions,
        "diagnostics": diagnostics,
        "logical_tasks": [],
        "source_fetches": [],
    }
    if base["requires_clarification"]:
        return base

    effective_request = normalized.get("effective_request")
    if not isinstance(effective_request, Mapping):
        raise ValueError("无歧义的雅仓意图必须包含 effective_request")
    data_types = _ordered_data_types(effective_request.get("data_types"))
    warehouses = _ordered_warehouses(effective_request.get("warehouses"))
    created_date_filter = (
        _created_date_filter(effective_request)
        if _INVENTORY_SALES_DATA_TYPE in data_types
        else None
    )
    logical_tasks: list[dict[str, Any]] = []
    source_fetches: list[dict[str, Any]] = []
    known_source_fetches: set[str] = set()

    for data_type in data_types:
        if data_type == _INVENTORY_SALES_DATA_TYPE:
            assert created_date_filter is not None
            for warehouse in warehouses:
                fetch_id = sales_source_fetch_id(
                    warehouse,
                    created_date_filter["created_start_date"],
                    created_date_filter["created_end_date"],
                )
                if fetch_id not in known_source_fetches:
                    known_source_fetches.add(fetch_id)
                    source_fetches.append(
                        {
                            "source_fetch_id": fetch_id,
                            "source_type": "inventory-sales-source",
                            "warehouse": warehouse,
                            "status": "not_run",
                            "effective_parameters": {
                                "warehouse": warehouse,
                                "created_date_filter": dict(created_date_filter),
                            },
                        }
                    )
                logical_tasks.append(
                    {
                        "task_id": f"{data_type}:{warehouse}",
                        "data_type": data_type,
                        "scope": "warehouse",
                        "warehouse": warehouse,
                        "status": "not_run",
                        "source_fetch_id": fetch_id,
                        "effective_parameters": {
                            "warehouse": warehouse,
                            "created_date_filter": dict(created_date_filter),
                        },
                    }
                )
            continue

        if data_type == _INVENTORY_DATA_TYPE:
            for warehouse in warehouses:
                logical_tasks.append(
                    {
                        "task_id": f"{data_type}:{warehouse}",
                        "data_type": data_type,
                        "scope": "warehouse",
                        "warehouse": warehouse,
                        "status": "not_run",
                        "snapshot": "current",
                        "effective_parameters": {"warehouse": warehouse},
                    }
                )
            continue

        if data_type == _INBOUND_DATA_TYPE:
            logical_tasks.append(
                {
                    "task_id": "inbound-listing-time:global",
                    "data_type": data_type,
                    "scope": "global",
                    "warehouse_scope": "all",
                    "status": "not_run",
                    "effective_parameters": {},
                }
            )

    return {
        **base,
        "logical_tasks": logical_tasks,
        "source_fetches": source_fetches,
    }


def run_export_workflow(
    request_text: Any,
    *,
    data_type_intent: Mapping[str, Any] | None = None,
    warehouse_intent: Mapping[str, Any] | None = None,
    created_date_filter: Mapping[str, Any] | None = None,
    inventory_snapshot_intent: Mapping[str, Any] | None = None,
    today: Callable[[], date] = date.today,
    executor: ExportPlanExecutor | None = None,
) -> CanonicalExportResult:
    """Normalize, plan, and execute one request through the frozen domain boundary."""
    execution_day = today()
    fixed_today = lambda: execution_day
    normalized = normalize_export_intent(
        request_text,
        data_type_intent=data_type_intent,
        warehouse_intent=warehouse_intent,
        created_date_filter=created_date_filter,
        inventory_snapshot_intent=inventory_snapshot_intent,
        today=fixed_today,
    )
    plan = plan_export_workflow(normalized, execution_date=execution_day.isoformat())
    validate_export_plan(plan)
    if plan["requires_clarification"]:
        return canonical_export_result(
            overall_status="needs_clarification",
            questions=plan["questions"],
            diagnostics=plan["diagnostics"],
        )

    if executor is None:
        from services.yacang.export_executor import execute_export_plan

        executor = execute_export_plan
    return validate_canonical_result(executor(plan))


def canonical_export_result(
    *,
    overall_status: str,
    tasks: Sequence[Mapping[str, Any]] = (),
    artifacts: Sequence[Mapping[str, Any]] = (),
    questions: Sequence[Mapping[str, Any]] = (),
    diagnostics: Sequence[Mapping[str, Any]] = (),
) -> CanonicalExportResult:
    if overall_status not in CANONICAL_RESULT_STATUSES:
        raise ValueError(f"不支持的雅仓整体状态: {overall_status}")
    return {
        "schema_version": EXPORT_PLAN_SCHEMA_VERSION,
        "overall_status": overall_status,
        "tasks": [dict(item) for item in tasks],
        "artifacts": [dict(item) for item in artifacts],
        "questions": [dict(item) for item in questions],
        "diagnostics": [dict(item) for item in diagnostics],
    }


def validate_export_plan(plan: Mapping[str, Any]) -> ExportPlan:
    required = {
        "schema_version",
        "execution_date",
        "requires_clarification",
        "questions",
        "diagnostics",
        "logical_tasks",
        "source_fetches",
    }
    if set(plan) != required:
        raise ValueError("ExportPlan 顶层字段不符合 schema_version=1 契约")
    if plan.get("schema_version") != EXPORT_PLAN_SCHEMA_VERSION:
        raise ValueError("不支持的 ExportPlan schema_version")
    for field in ("questions", "diagnostics", "logical_tasks", "source_fetches"):
        if not isinstance(plan.get(field), list):
            raise ValueError(f"ExportPlan.{field} 必须是列表")
    if bool(plan.get("requires_clarification")) and (
        plan.get("logical_tasks") or plan.get("source_fetches")
    ):
        raise ValueError("需要澄清的 ExportPlan 不得包含任务或物理数据获取")
    return dict(plan)  # type: ignore[return-value]


def validate_canonical_result(result: Mapping[str, Any]) -> CanonicalExportResult:
    required = {
        "schema_version",
        "overall_status",
        "tasks",
        "artifacts",
        "questions",
        "diagnostics",
    }
    if set(result) != required:
        raise ValueError("雅仓 canonical result 顶层字段不符合契约")
    if result.get("schema_version") != EXPORT_PLAN_SCHEMA_VERSION:
        raise ValueError("不支持的 canonical result schema_version")
    if result.get("overall_status") not in CANONICAL_RESULT_STATUSES:
        raise ValueError("canonical result.overall_status 无效")
    for field in ("tasks", "artifacts", "questions", "diagnostics"):
        if not isinstance(result.get(field), list):
            raise ValueError(f"canonical result.{field} 必须是列表")
    return dict(result)  # type: ignore[return-value]


def normalize_export_request(
    request_text: Any,
    *,
    today: Callable[[], date] = date.today,
) -> dict[str, Any]:
    """Temporary legacy adapter retained until the legacy execution path is migrated."""
    normalized = normalize_export_intent(request_text, today=today)
    effective_request = normalized.get("effective_request")
    effective = effective_request if isinstance(effective_request, Mapping) else {}
    created = effective.get("created_date_filter")
    if not isinstance(created, Mapping):
        start, end = resolve_source_date_range(today=today)
        created = {
            "mode": "default",
            "created_start_date": start.isoformat(),
            "created_end_date": end.isoformat(),
        }
    return {
        "requires_clarification": bool(normalized["requires_clarification"]),
        "questions": [str(item.get("message") or "") for item in _records(normalized.get("questions"))],
        "date_mode": "explicit" if created.get("mode") == "explicit_range" else "default",
        "start_date": str(created["created_start_date"]),
        "end_date": str(created["created_end_date"]),
        "warehouses": list(effective.get("warehouses") or WAREHOUSE_CODES),
        "data_types": [str(data_type) for data_type in effective.get("data_types") or []],
    }


def _ordered_data_types(value: Any) -> list[str]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes)):
        raise ValueError("effective_request.data_types 必须是列表")
    requested = [str(item) for item in value]
    unknown = sorted(set(requested).difference(CANONICAL_DATA_TYPES))
    if unknown:
        raise ValueError(f"不支持的正式雅仓数据类型: {', '.join(unknown)}")
    return [data_type for data_type in CANONICAL_DATA_TYPES if data_type in requested]


def _ordered_warehouses(value: Any) -> list[str]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes)):
        raise ValueError("effective_request.warehouses 必须是列表")
    requested = [str(item).strip().upper() for item in value]
    unknown = sorted(set(requested).difference(WAREHOUSE_CODES))
    if unknown:
        raise ValueError(f"不支持的雅仓仓库: {', '.join(unknown)}")
    return [warehouse for warehouse in WAREHOUSE_CODES if warehouse in requested]


def _created_date_filter(effective_request: Mapping[str, Any]) -> dict[str, Any]:
    value = effective_request.get("created_date_filter")
    if not isinstance(value, Mapping):
        raise ValueError("销量任务必须包含 created_date_filter")
    result = dict(value)
    for field in ("created_start_date", "created_end_date"):
        if not str(result.get(field) or "").strip():
            raise ValueError(f"created_date_filter 缺少 {field}")
    return result


def _records(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes)):
        return []
    return [dict(item) for item in value if isinstance(item, Mapping)]


__all__ = [
    "ALL_DATA_TYPES",
    "CANONICAL_RESULT_STATUSES",
    "CanonicalExportResult",
    "EXPORT_PLAN_SCHEMA_VERSION",
    "ExportPlan",
    "ExportPlanExecutor",
    "canonical_export_result",
    "normalize_export_request",
    "plan_export_workflow",
    "run_export_workflow",
    "sales_source_fetch_id",
    "validate_canonical_result",
    "validate_export_plan",
]
