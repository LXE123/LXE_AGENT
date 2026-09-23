from __future__ import annotations

import json
from typing import Any

import pytest

from services.yacang.errors import YacangError
from services.yacang.exports.inventory_sales import ExportRequest
from services.yacang.queue import YacangExportQueue


class Clock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.now += seconds


class QueueClient:
    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self.rows = rows
        self.calls = 0

    def list_downloads(self, *, limit: int = 50) -> list[dict[str, Any]]:
        self.calls += 1
        return self.rows


def _request() -> ExportRequest:
    return ExportRequest("MY8801", 26, "2026-09-01", "2026-09-13")


def _matching_task(*, path: str = "") -> dict[str, Any]:
    return {
        "id": "new",
        "name": "库存动销导出",
        "type": "10",
        "path": path,
        "param_where": json.dumps([
            ["warehouse_id", "in", ["26"]],
            ["create_time", ">=", 1788192000],
            ["create_time", "<", 1789315200],
        ]),
    }


def test_empty_path_remains_pending_until_poll_timeout() -> None:
    clock = Clock()
    queue = YacangExportQueue(QueueClient([_matching_task()]), clock=clock)

    with pytest.raises(YacangError) as caught:
        queue.wait_for_file(
            _request(), baseline_ids=set(), timeout_seconds=2, poll_interval_seconds=1,
            sleep=clock.sleep,
        )

    assert caught.value.code == "EXPORT_POLL_TIMEOUT"
    assert caught.value.scope == "local"


def test_unmatchable_same_type_task_is_status_unknown() -> None:
    clock = Clock()
    task = {**_matching_task(), "param_where": "not-json"}
    queue = YacangExportQueue(QueueClient([task]), clock=clock)

    with pytest.raises(YacangError) as caught:
        queue.wait_for_file(
            _request(), baseline_ids=set(), timeout_seconds=1, poll_interval_seconds=1,
            sleep=clock.sleep,
        )

    assert caught.value.code == "EXPORT_STATUS_UNKNOWN"
    assert caught.value.scope == "global"


def test_matching_task_requires_allowlisted_https_xlsx_url() -> None:
    queue = YacangExportQueue(QueueClient([_matching_task(path="http://example.invalid/a.xlsx")]))

    with pytest.raises(YacangError) as caught:
        queue.wait_for_file(
            _request(), baseline_ids=set(), timeout_seconds=1, poll_interval_seconds=1,
            sleep=lambda _seconds: None,
        )

    assert caught.value.code == "EXPORT_STATUS_UNKNOWN"


def test_matching_task_with_trusted_url_succeeds() -> None:
    expected = "https://oss-accelerate.seaya.cn/test/result.xlsx"
    queue = YacangExportQueue(QueueClient([_matching_task(path=expected)]))
    assert queue.wait_for_file(
        _request(), baseline_ids=set(), timeout_seconds=1, poll_interval_seconds=1,
        sleep=lambda _seconds: None,
    ) == expected
