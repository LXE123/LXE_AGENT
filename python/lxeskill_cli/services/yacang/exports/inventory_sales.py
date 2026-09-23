from __future__ import annotations

import time
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any, Callable, Iterable, Sequence

from services.yacang.auth import login_from_environment
from services.yacang.client import YacangClient
from services.yacang.download import staged_xlsx_path
from services.yacang.errors import YacangError
from services.yacang.queue import YacangExportQueue, task_matches_warehouse_request
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
from services.yacang.validation import INVENTORY_SALES_HEADERS, validate_inventory_sales_workbook
from services.yacang.warehouses import WAREHOUSES as WAREHOUSE_SPECS
from shared.datasets import dataset_dir


WAREHOUSES: tuple[tuple[str, int], ...] = tuple(
    (warehouse.code, warehouse.warehouse_id) for warehouse in WAREHOUSE_SPECS
)
EXPECTED_HEADERS = INVENTORY_SALES_HEADERS
EXPORT_NAME = "库存动销导出"
EXPORT_TYPE = "10"
DEFAULT_POLL_INTERVAL_SECONDS = 5.0
DEFAULT_TIMEOUT_SECONDS = 180.0
DEFAULT_CACHE_MAX_AGE_SECONDS = 300.0
CACHE_CLOCK_SKEW_SECONDS = 5.0


@dataclass(frozen=True)
class ExportRequest:
    warehouse_code: str
    warehouse_id: int
    start_date: str
    end_date: str
    output_filename: str = ""
    business_key: str = "inventory-sales"
    queue_name: str = EXPORT_NAME
    queue_type: str = EXPORT_TYPE
    range_days: int | None = None

    @property
    def filename(self) -> str:
        return self.output_filename or (
            f"yacang_inventory_sales_{self.warehouse_code}_{self.start_date}_{self.end_date}.xlsx"
        )


def _iso_date(value: Any, name: str) -> str:
    text = str(value or "").strip()
    try:
        return date.fromisoformat(text).isoformat()
    except ValueError as exc:
        raise ValueError(f"{name} 必须是 YYYY-MM-DD，收到: {text or '[empty]'}") from exc


def validate_date_range(start_date: Any, end_date: Any) -> tuple[str, str]:
    start = _iso_date(start_date, "start_date")
    end = _iso_date(end_date, "end_date")
    if start > end:
        raise ValueError(f"start_date 不能晚于 end_date: {start} > {end}")
    return start, end


def task_matches_request(task: dict[str, Any], request: ExportRequest) -> bool:
    return task_matches_warehouse_request(task, request)


def validate_workbook(path: Path, *, warehouse_code: str) -> int:
    return validate_inventory_sales_workbook(path, warehouse_code=warehouse_code)


def _cached_file(path: Path, *, warehouse_code: str, max_age_seconds: float) -> int | None:
    if max_age_seconds <= 0 or not path.is_file():
        return None
    age = time.time() - path.stat().st_mtime
    if age < -CACHE_CLOCK_SKEW_SECONDS or age > max_age_seconds:
        return None
    try:
        return validate_inventory_sales_workbook(path, warehouse_code=warehouse_code)
    except YacangError:
        return None


def _registered_output_dir(dataset_id: str) -> Path:
    if dataset_id == "yacang_inventory_sales":
        return dataset_dir("yacang_inventory_sales")
    if dataset_id == "yacang_exports":
        return dataset_dir("yacang_exports")
    raise ValueError(f"未注册的雅仓产物目录: {dataset_id}")


def export_inventory_sales_requests(
    requests: Sequence[ExportRequest],
    *,
    dataset_id: str,
    mobile: str | None = None,
    password: str | None = None,
    output_dir: str | Path | None = None,
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
    poll_interval_seconds: float = DEFAULT_POLL_INTERVAL_SECONDS,
    cache_max_age_seconds: float = DEFAULT_CACHE_MAX_AGE_SECONDS,
    client: YacangClient | None = None,
    submission_store: SubmissionBackend | None = None,
    sleep: Callable[[float], None] = time.sleep,
) -> list[dict[str, Any]]:
    if timeout_seconds <= 0 or poll_interval_seconds <= 0:
        raise ValueError("timeout_seconds 和 poll_interval_seconds 必须大于 0")
    if not requests:
        raise ValueError("至少需要一个导出任务")

    destination_dir = Path(output_dir) if output_dir is not None else _registered_output_dir(dataset_id)
    destination_dir.mkdir(parents=True, exist_ok=True)
    results: list[dict[str, Any]] = []
    pending: list[tuple[ExportRequest, Path]] = []
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
            first_request, _first_path = pending[0]
            results.append(failed_export(_request_context(first_request), exc))
            results.extend(
                skipped_export(_request_context(request), reason="全局登录失败，未继续生产请求")
                for request, _path in pending[1:]
            )
            return _ordered_results(requests, results)
        queue = YacangExportQueue(api)
        risk = YacangRiskController(sleep=sleep)
        for index, (request, path) in enumerate(pending):
            staged_path = staged_xlsx_path(path)
            key = submission_key(
                business_key=request.business_key,
                warehouse_code=request.warehouse_code,
                start_date=request.start_date,
                end_date=request.end_date,
            )
            try:
                baseline_ids = {str(task.get("id") or "") for task in api.list_downloads()}
                record, should_submit = store.acquire(key, baseline_ids)
                if should_submit:
                    risk.before_submission(request)
                    try:
                        api.create_inventory_sales_export(
                            warehouse_id=request.warehouse_id,
                            start_date=request.start_date,
                            end_date=request.end_date,
                        )
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
                )
                api.download_xlsx(remote_path, staged_path)
                row_count = validate_inventory_sales_workbook(
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
                            _request_context(later_request),
                            reason=f"前序全局错误 {getattr(exc, 'code', type(exc).__name__)}，未继续生产请求",
                        )
                        for later_request, _later_path in pending[index + 1:]
                    )
                    break

    return _ordered_results(requests, results)


def _request_context(request: ExportRequest) -> dict[str, Any]:
    return {
        "business_type": request.business_key,
        "warehouse": request.warehouse_code,
        "warehouse_id": request.warehouse_id,
        "start_date": request.start_date,
        "end_date": request.end_date,
        "output_filename": request.filename,
    }


def _ordered_results(
    requests: Sequence[ExportRequest],
    results: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    by_name = {str(item.get("output_filename") or Path(str(item.get("xlsx_path") or "")).name): item for item in results}
    return [by_name[request.filename] for request in requests]


def _result(
    request: ExportRequest,
    path: Path,
    *,
    row_count: int,
    source: str,
) -> dict[str, Any]:
    return {
        **_request_context(request),
        **({"range_days": request.range_days} if request.range_days is not None else {}),
        "xlsx_path": str(path),
        "row_count": row_count,
        "source": source,
    }


def export_inventory_sales(
    *,
    start_date: Any,
    end_date: Any,
    mobile: str | None = None,
    password: str | None = None,
    output_dir: str | Path | None = None,
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
    poll_interval_seconds: float = DEFAULT_POLL_INTERVAL_SECONDS,
    cache_max_age_seconds: float = DEFAULT_CACHE_MAX_AGE_SECONDS,
    client: YacangClient | None = None,
    sleep: Callable[[float], None] = time.sleep,
) -> dict[str, Any]:
    start, end = validate_date_range(start_date, end_date)
    requests = [ExportRequest(code, warehouse_id, start, end) for code, warehouse_id in WAREHOUSES]
    results = export_inventory_sales_requests(
        requests,
        dataset_id="yacang_inventory_sales",
        mobile=mobile,
        password=password,
        output_dir=output_dir,
        timeout_seconds=timeout_seconds,
        poll_interval_seconds=poll_interval_seconds,
        cache_max_age_seconds=cache_max_age_seconds,
        client=client,
        sleep=sleep,
    )
    summary = summarize_exports(results)
    return {
        **summary,
        "start_date": start,
        "end_date": end,
        "sales_window_days": 15,
        "warehouse_count": len(WAREHOUSES),
    }


__all__ = [
    "DEFAULT_CACHE_MAX_AGE_SECONDS",
    "EXPECTED_HEADERS",
    "ExportRequest",
    "WAREHOUSES",
    "export_inventory_sales",
    "export_inventory_sales_requests",
    "task_matches_request",
    "validate_date_range",
    "validate_workbook",
]
