from __future__ import annotations

import json
import time
from datetime import date, datetime, time as datetime_time, timedelta
from typing import Any, Callable, Iterable, Protocol
from zoneinfo import ZoneInfo

from services.yacang.download import is_trusted_xlsx_url
from services.yacang.errors import YacangError, safe_remote_detail


class QueueClient(Protocol):
    def list_downloads(self, *, limit: int = 50) -> list[dict[str, Any]]: ...


class WarehouseQueueRequest(Protocol):
    warehouse_id: int
    queue_name: str
    queue_type: str
    start_date: str
    end_date: str


def _conditions(value: Any) -> Iterable[tuple[str, str, Any]]:
    if isinstance(value, list):
        if len(value) >= 3 and isinstance(value[0], str) and isinstance(value[1], str):
            yield str(value[0]), str(value[1]), value[2]
        for child in value:
            yield from _conditions(child)
    elif isinstance(value, dict):
        for child in value.values():
            yield from _conditions(child)


def _yacang_midnight_epoch(value: str) -> int:
    day = date.fromisoformat(value)
    return int(datetime.combine(day, datetime_time.min, ZoneInfo("Asia/Shanghai")).timestamp())


def task_matches_warehouse_request(task: dict[str, Any], request: WarehouseQueueRequest) -> bool:
    if str(task.get("type") or "") != request.queue_type or str(task.get("name") or "") != request.queue_name:
        return False
    raw_where = task.get("param_where")
    try:
        where = json.loads(raw_where) if isinstance(raw_where, str) else raw_where
    except json.JSONDecodeError:
        return False
    warehouse = str(request.warehouse_id)
    parsed_conditions = list(_conditions(where))
    warehouse_matches = any(
        key == "warehouse_id"
        and operator in {"=", "in"}
        and warehouse in {str(item) for item in (value if isinstance(value, list) else [value])}
        for key, operator, value in parsed_conditions
    )
    if not warehouse_matches:
        return False

    expected_start = _yacang_midnight_epoch(request.start_date)
    expected_end = _yacang_midnight_epoch((date.fromisoformat(request.end_date) + timedelta(days=1)).isoformat())
    return (
        ("create_time", ">=", expected_start) in parsed_conditions
        and ("create_time", "<", expected_end) in parsed_conditions
    )


class YacangExportQueue:
    def __init__(self, client: QueueClient, *, clock: Callable[[], float] = time.monotonic) -> None:
        self.client = client
        self.clock = clock

    def wait_for_file(
        self,
        request: Any,
        *,
        baseline_ids: set[str],
        timeout_seconds: float,
        poll_interval_seconds: float,
        sleep: Callable[[float], None] = time.sleep,
        matcher: Callable[[dict[str, Any], Any], bool] = task_matches_warehouse_request,
    ) -> str:
        deadline = self.clock() + timeout_seconds
        last_candidates: list[dict[str, Any]] = []
        ambiguous_candidates: list[dict[str, Any]] = []
        while True:
            tasks = self.client.list_downloads()
            new_tasks = [
                task for task in tasks
                if str(task.get("id") or "") not in baseline_ids
            ]
            last_candidates = [
                task for task in new_tasks if matcher(task, request)
            ]
            ambiguous_candidates = [
                task for task in new_tasks
                if str(task.get("type") or "") == str(request.queue_type)
                and str(task.get("name") or "") == str(request.queue_name)
                and not matcher(task, request)
            ]
            for task in last_candidates:
                path = str(task.get("path") or "").strip()
                if path:
                    if not is_trusted_xlsx_url(path):
                        raise YacangError(
                            "读取导出状态",
                            "匹配任务返回了不合法的下载地址",
                            code="EXPORT_STATUS_UNKNOWN",
                            scope="global",
                        )
                    return path
            if self.clock() >= deadline:
                if ambiguous_candidates:
                    detail = safe_remote_detail({"ambiguous_matching_tasks": len(ambiguous_candidates)})
                    raise YacangError(
                        "读取导出状态",
                        f"任务状态无法确认: {detail}",
                        code="EXPORT_STATUS_UNKNOWN",
                        scope="global",
                    )
                detail = safe_remote_detail(last_candidates or {"new_matching_tasks": 0})
                raise YacangError(
                    "等待导出队列",
                    f"{timeout_seconds:g} 秒超时，最后状态: {detail}",
                    code="EXPORT_POLL_TIMEOUT",
                )
            sleep(poll_interval_seconds)


__all__ = ["YacangExportQueue", "task_matches_warehouse_request"]
