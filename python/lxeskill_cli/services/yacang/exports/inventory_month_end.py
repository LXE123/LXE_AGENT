from __future__ import annotations

import json
import time
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any, Callable, Sequence

from services.yacang.auth import login_from_environment
from services.yacang.client import YacangClient
from services.yacang.download import staged_xlsx_path
from services.yacang.errors import YacangError
from services.yacang.naming import YacangExportKind, export_filename
from services.yacang.queue import YacangExportQueue
from services.yacang.reporting import (
    failed_export,
    is_global_error,
    skipped_export,
    successful_export,
    summarize_exports,
)
from services.yacang.risk import YacangRiskController
from services.yacang.submission import (
    MemorySubmissionStore,
    SubmissionBackend,
    YacangSubmissionStore,
    submission_key,
)
from services.yacang.validation import validate_inventory_list_workbook
from services.yacang.warehouses import select_warehouses
from shared.datasets import dataset_dir


EXPORT_NAME = "库存导出"
EXPORT_TYPE = "1"
GOODS_SKU_CONDITION = 2
DEFAULT_POLL_INTERVAL_SECONDS = 5.0
DEFAULT_TIMEOUT_SECONDS = 180.0
DEFAULT_CACHE_MAX_AGE_SECONDS = 300.0
CACHE_CLOCK_SKEW_SECONDS = 5.0
CURRENT_INVENTORY_BUSINESS_TYPE = "inventory-current-snapshot"


@dataclass(frozen=True)
class InventoryCurrentSnapshotRequest:
    warehouse_code: str
    warehouse_id: int
    as_of_date: str
    business_key: str = CURRENT_INVENTORY_BUSINESS_TYPE
    queue_name: str = EXPORT_NAME
    queue_type: str = EXPORT_TYPE

    @property
    def start_date(self) -> str:
        return self.as_of_date

    @property
    def end_date(self) -> str:
        return self.as_of_date

    @property
    def filename(self) -> str:
        return export_filename(
            YacangExportKind.INVENTORY_CURRENT_SNAPSHOT,
            warehouse_code=self.warehouse_code,
            file_date=self.as_of_date,
        )


def _parse_param_where(value: Any) -> dict[str, Any] | None:
    try:
        parsed = json.loads(value) if isinstance(value, str) else value
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


def task_matches_inventory_current_snapshot(
    task: dict[str, Any],
    request: InventoryCurrentSnapshotRequest,
) -> bool:
    if str(task.get("type") or "") != request.queue_type:
        return False
    if str(task.get("name") or "") != request.queue_name:
        return False
    where = _parse_param_where(task.get("param_where"))
    if where is None:
        return False
    return (
        str(where.get("warehouse_id") or "") == str(request.warehouse_id)
        and str(where.get("goods_sku_condition") or "") == str(GOODS_SKU_CONDITION)
    )


def _cached_file(path: Path, *, warehouse_code: str, max_age_seconds: float) -> int | None:
    if max_age_seconds <= 0 or not path.is_file():
        return None
    age = time.time() - path.stat().st_mtime
    if age < -CACHE_CLOCK_SKEW_SECONDS or age > max_age_seconds:
        return None
    try:
        return validate_inventory_list_workbook(path, warehouse_code=warehouse_code)
    except YacangError:
        return None


def _resolve_as_of_date(value: Any, *, today: Callable[[], date]) -> str:
    current = today().isoformat()
    if value is None or str(value).strip() == "":
        return current
    requested = date.fromisoformat(str(value).strip()).isoformat()
    if requested != current:
        raise ValueError(
            "库存列表接口不支持历史快照日期；as_of_date 必须是执行当天，"
            f"当前为 {current}，收到 {requested}"
        )
    return requested


def export_inventory_current_snapshot(
    *,
    as_of_date: Any = None,
    warehouse: Any = None,
    warehouses: Any = None,
    mobile: str | None = None,
    password: str | None = None,
    output_dir: str | Path | None = None,
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
    poll_interval_seconds: float = DEFAULT_POLL_INTERVAL_SECONDS,
    cache_max_age_seconds: float = DEFAULT_CACHE_MAX_AGE_SECONDS,
    client: YacangClient | None = None,
    submission_store: SubmissionBackend | None = None,
    sleep: Callable[[float], None] = time.sleep,
    today: Callable[[], date] = date.today,
) -> dict[str, Any]:
    if timeout_seconds <= 0 or poll_interval_seconds <= 0:
        raise ValueError("timeout_seconds 和 poll_interval_seconds 必须大于 0")
    snapshot_date = _resolve_as_of_date(as_of_date, today=today)
    if warehouse is not None and warehouses is not None:
        raise ValueError("warehouse 和 warehouses 不能同时提供")
    selected_warehouses = select_warehouses(warehouses if warehouses is not None else warehouse)
    requests: Sequence[InventoryCurrentSnapshotRequest] = tuple(
        InventoryCurrentSnapshotRequest(spec.code, spec.warehouse_id, snapshot_date)
        for spec in selected_warehouses
    )
    destination_dir = Path(output_dir) if output_dir is not None else dataset_dir("yacang_exports")
    destination_dir.mkdir(parents=True, exist_ok=True)

    results: list[dict[str, Any]] = []
    pending: list[tuple[InventoryCurrentSnapshotRequest, Path]] = []
    for request in requests:
        path = destination_dir / request.filename
        cached_rows = _cached_file(
            path,
            warehouse_code=request.warehouse_code,
            max_age_seconds=cache_max_age_seconds,
        )
        if cached_rows is None:
            pending.append((request, path))
        else:
            results.append(successful_export(_result(request, path, row_count=cached_rows, source="cache")))

    if pending:
        api = client or YacangClient()
        store = submission_store or (
            YacangSubmissionStore() if client is None else MemorySubmissionStore()
        )
        try:
            login_from_environment(api, mobile=mobile, password=password)
        except Exception as exc:
            first, _first_path = pending[0]
            results.append(failed_export(_request_context(first), exc))
            results.extend(
                skipped_export(_request_context(request), reason="全局登录失败，未继续生产请求")
                for request, _path in pending[1:]
            )
            return _inventory_result(snapshot_date, requests, results)
        queue = YacangExportQueue(api)
        risk = YacangRiskController(sleep=sleep)
        for index, (request, path) in enumerate(pending):
            staged_path = staged_xlsx_path(path)
            key = submission_key(
                business_key=request.business_key,
                warehouse_code=request.warehouse_code,
                start_date=request.as_of_date,
                end_date=request.as_of_date,
            )
            try:
                baseline_ids = {str(task.get("id") or "") for task in api.list_downloads()}
                record, should_submit = store.acquire(key, baseline_ids)
                if should_submit:
                    risk.before_submission(request)
                    try:
                        api.create_inventory_list_export(warehouse_id=request.warehouse_id)
                    except Exception as exc:
                        if isinstance(exc, YacangError) and exc.code == "EXPORT_SUBMIT_UNKNOWN":
                            store.set_state(key, "submit_unknown")
                        else:
                            store.clear(key)
                        raise
                    store.set_state(key, "queued")
                remote_path = queue.wait_for_file(
                    request,
                    baseline_ids=record.baseline_ids,
                    timeout_seconds=float(timeout_seconds),
                    poll_interval_seconds=float(poll_interval_seconds),
                    sleep=sleep,
                    matcher=task_matches_inventory_current_snapshot,
                )
                api.download_xlsx(remote_path, staged_path)
                row_count = validate_inventory_list_workbook(
                    staged_path,
                    warehouse_code=request.warehouse_code,
                )
                staged_path.replace(path)
                store.clear(key)
                results.append(successful_export(_result(request, path, row_count=row_count, source="yacang")))
            except Exception as exc:
                staged_path.unlink(missing_ok=True)
                status = (
                    "submit_unknown"
                    if isinstance(exc, YacangError) and exc.code == "EXPORT_SUBMIT_UNKNOWN"
                    else "failed"
                )
                results.append(failed_export(_request_context(request), exc, status=status))
                if is_global_error(exc):
                    results.extend(
                        skipped_export(
                            _request_context(later),
                            reason=f"前序全局错误 {getattr(exc, 'code', type(exc).__name__)}，未继续生产请求",
                        )
                        for later, _later_path in pending[index + 1:]
                    )
                    break

    return _inventory_result(snapshot_date, requests, results)


def _request_context(request: InventoryCurrentSnapshotRequest) -> dict[str, Any]:
    return {
        "business_type": request.business_key,
        "warehouse": request.warehouse_code,
        "warehouse_id": request.warehouse_id,
        "as_of_date": request.as_of_date,
        "output_filename": request.filename,
    }


def _inventory_result(
    snapshot_date: str,
    requests: Sequence[InventoryCurrentSnapshotRequest],
    results: list[dict[str, Any]],
) -> dict[str, Any]:
    by_name = {str(item.get("output_filename") or Path(str(item.get("xlsx_path") or "")).name): item for item in results}
    ordered = [by_name[request.filename] for request in requests]
    summary = summarize_exports(ordered)
    return {
        **summary,
        "business_type": CURRENT_INVENTORY_BUSINESS_TYPE,
        "as_of_date": snapshot_date,
        "snapshot_semantics": "current-at-execution",
    }


def _result(
    request: InventoryCurrentSnapshotRequest,
    path: Path,
    *,
    row_count: int,
    source: str,
) -> dict[str, Any]:
    return {
        **_request_context(request),
        "xlsx_path": str(path),
        "row_count": row_count,
        "source": source,
    }


# Compatibility aliases retain old import paths without leaking the legacy type
# into requests, tasks, filenames, or result payloads.
InventoryMonthEndRequest = InventoryCurrentSnapshotRequest
task_matches_inventory_month_end = task_matches_inventory_current_snapshot
export_inventory_month_end = export_inventory_current_snapshot


__all__ = [
    "CURRENT_INVENTORY_BUSINESS_TYPE",
    "GOODS_SKU_CONDITION",
    "InventoryCurrentSnapshotRequest",
    "InventoryMonthEndRequest",
    "export_inventory_current_snapshot",
    "export_inventory_month_end",
    "task_matches_inventory_current_snapshot",
    "task_matches_inventory_month_end",
]
