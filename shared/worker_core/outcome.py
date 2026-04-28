from __future__ import annotations

from dataclasses import dataclass
from typing import Awaitable, Callable, Literal


RetryFinalizer = Callable[[object, str], Awaitable[None]]


@dataclass(slots=True)
class WorkerOutcome:
    kind: Literal["handled", "retry"]
    error_message: str = ""
    retry_delay_seconds: int | None = None
    on_retry_exhausted: RetryFinalizer | None = None


def job_handled() -> WorkerOutcome:
    return WorkerOutcome(kind="handled")


def job_retry(
    error_message: str,
    *,
    retry_delay_seconds: int | None = None,
    on_retry_exhausted: RetryFinalizer | None = None,
) -> WorkerOutcome:
    return WorkerOutcome(
        kind="retry",
        error_message=str(error_message or "").strip() or "unknown error",
        retry_delay_seconds=retry_delay_seconds,
        on_retry_exhausted=on_retry_exhausted,
    )
