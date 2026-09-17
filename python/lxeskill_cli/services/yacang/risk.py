from __future__ import annotations

import time
from typing import Callable, Protocol

from services.yacang.errors import YacangError
from services.yacang.warehouses import WAREHOUSE_IDS


class RiskRequest(Protocol):
    business_key: str
    warehouse_code: str
    warehouse_id: int
    start_date: str
    end_date: str


class YacangRiskController:
    """Fail closed on duplicate/unknown submissions and space production writes."""

    def __init__(
        self,
        *,
        minimum_submission_interval_seconds: float = 1.0,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self.minimum_submission_interval_seconds = minimum_submission_interval_seconds
        self.clock = clock
        self.sleep = sleep
        self._submitted: set[tuple[str, int | None, str, str]] = set()
        self._last_submission_at: float | None = None

    def before_submission(self, request: RiskRequest) -> None:
        if WAREHOUSE_IDS.get(request.warehouse_code) != request.warehouse_id:
            raise YacangError("风控检查", f"未授权仓库映射: {request.warehouse_code}/{request.warehouse_id}")
        key = (request.business_key, request.warehouse_id, request.start_date, request.end_date)
        self._before_key(key, label=request.warehouse_code)

    def before_global_submission(self, *, business_key: str, request_key: str) -> None:
        key = (str(business_key), None, str(request_key), str(request_key))
        self._before_key(key, label=str(business_key))

    def _before_key(
        self,
        key: tuple[str, int | None, str, str],
        *,
        label: str,
    ) -> None:
        if key in self._submitted:
            raise YacangError("风控检查", f"本次运行已提交相同任务: {label}")
        if self._last_submission_at is not None:
            remaining = self.minimum_submission_interval_seconds - (self.clock() - self._last_submission_at)
            if remaining > 0:
                self.sleep(remaining)
        self._submitted.add(key)
        self._last_submission_at = self.clock()


__all__ = ["YacangRiskController"]
