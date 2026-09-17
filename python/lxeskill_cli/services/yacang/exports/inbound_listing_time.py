from __future__ import annotations

import json
import time
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any, Callable, Iterable

from services.yacang.auth import login_from_environment
from services.yacang.client import YacangClient
from services.yacang.download import staged_xlsx_path
from services.yacang.errors import YacangError
from services.yacang.naming import YacangExportKind, export_filename
from services.yacang.queue import YacangExportQueue
from services.yacang.reporting import successful_export, summarize_exports
from services.yacang.risk import YacangRiskController
from services.yacang.submission import (
    MemorySubmissionStore,
    SubmissionBackend,
    YacangSubmissionStore,
    submission_key,
)
from services.yacang.validation import validate_inbound_listing_time_workbook
from shared.datasets import dataset_dir


EXPORT_NAME = "资料导出"
EXPORT_TYPE = "6"
DEFAULT_POLL_INTERVAL_SECONDS = 5.0
DEFAULT_TIMEOUT_SECONDS = 180.0
DEFAULT_CACHE_MAX_AGE_SECONDS = 300.0
CACHE_CLOCK_SKEW_SECONDS = 5.0


@dataclass(frozen=True)
class InboundListingTimeRequest:
    as_of_date: str
    business_key: str = "inbound-listing-time"
    queue_name: str = EXPORT_NAME
    queue_type: str = EXPORT_TYPE

    @property
    def filename(self) -> str:
        return export_filename(
            YacangExportKind.INBOUND_LISTING_TIME,
            file_date=self.as_of_date,
        )


def _conditions(value: Any) -> Iterable[tuple[str, str, Any]]:
    if isinstance(value, list):
        if len(value) >= 3 and isinstance(value[0], str) and isinstance(value[1], str):
            yield str(value[0]), str(value[1]), value[2]
        for child in value:
            yield from _conditions(child)
    elif isinstance(value, dict):
        for child in value.values():
            yield from _conditions(child)


def task_matches_inbound_listing_time(
    task: dict[str, Any],
    request: InboundListingTimeRequest,
) -> bool:
    if str(task.get("type") or "") != request.queue_type:
        return False
    if str(task.get("name") or "") != request.queue_name:
        return False
    raw_where = task.get("param_where")
    try:
        where = json.loads(raw_where) if isinstance(raw_where, str) else raw_where
    except json.JSONDecodeError:
        return False
    return any(
        key == "status" and operator == "=" and str(value) == "1"
        for key, operator, value in _conditions(where)
    )


def _resolve_as_of_date(value: Any, *, today: Callable[[], date]) -> str:
    current = today().isoformat()
    if value is None or str(value).strip() == "":
        return current
    requested = date.fromisoformat(str(value).strip()).isoformat()
    if requested != current:
        raise ValueError(
            "仓库产品接口只导出执行时的当前资料；as_of_date 必须是执行当天，"
            f"当前为 {current}，收到 {requested}"
        )
    return requested


def _cached_file(path: Path, *, max_age_seconds: float) -> int | None:
    if max_age_seconds <= 0 or not path.is_file():
        return None
    age = time.time() - path.stat().st_mtime
    if age < -CACHE_CLOCK_SKEW_SECONDS or age > max_age_seconds:
        return None
    try:
        return validate_inbound_listing_time_workbook(path)
    except YacangError:
        return None


def export_inbound_listing_time(
    *,
    as_of_date: Any = None,
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
    file_date = _resolve_as_of_date(as_of_date, today=today)
    request = InboundListingTimeRequest(file_date)
    destination_dir = Path(output_dir) if output_dir is not None else dataset_dir("yacang_exports")
    destination_dir.mkdir(parents=True, exist_ok=True)
    path = destination_dir / request.filename

    cached_rows = _cached_file(path, max_age_seconds=cache_max_age_seconds)
    if cached_rows is not None:
        return _result(request, path, row_count=cached_rows, source="cache")

    api = client or YacangClient()
    store = submission_store or (
        YacangSubmissionStore() if client is None else MemorySubmissionStore()
    )
    login_from_environment(api, mobile=mobile, password=password)
    queue = YacangExportQueue(api)
    risk = YacangRiskController(sleep=sleep)
    baseline_ids = {str(task.get("id") or "") for task in api.list_downloads()}
    key = submission_key(
        business_key=request.business_key,
        warehouse_code="all",
        start_date=request.as_of_date,
        end_date=request.as_of_date,
    )
    record, should_submit = store.acquire(key, baseline_ids)
    if should_submit:
        risk.before_global_submission(
            business_key=request.business_key,
            request_key=request.as_of_date,
        )
        try:
            api.create_inbound_listing_time_export()
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
        matcher=task_matches_inbound_listing_time,
    )
    staged_path = staged_xlsx_path(path)
    try:
        api.download_xlsx(remote_path, staged_path)
        row_count = validate_inbound_listing_time_workbook(staged_path)
        staged_path.replace(path)
        store.clear(key)
    except Exception:
        staged_path.unlink(missing_ok=True)
        raise
    return _result(request, path, row_count=row_count, source="yacang")


def _result(
    request: InboundListingTimeRequest,
    path: Path,
    *,
    row_count: int,
    source: str,
) -> dict[str, Any]:
    export = successful_export({
        "business_type": request.business_key,
        "as_of_date": request.as_of_date,
        "output_filename": request.filename,
        "xlsx_path": str(path),
        "row_count": row_count,
        "source": source,
    })
    summary = summarize_exports([export])
    return {
        **summary,
        "business_type": request.business_key,
        "as_of_date": request.as_of_date,
        "creation_time_field": "创建时间",
    }


__all__ = [
    "InboundListingTimeRequest",
    "export_inbound_listing_time",
    "task_matches_inbound_listing_time",
]
