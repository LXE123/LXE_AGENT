from __future__ import annotations

import asyncio
from dataclasses import dataclass

from gateway.session_scheduler import SessionScheduler
from shared.agent_ipc import AgentJob, HeartbeatWakeRequest
from shared.db.client import has_agent_session_pending_events, load_agent_session
from shared.logging import logger

_NORMAL_DELAY_S = 0.25
_RETRY_DELAY_S = 1.0
_WAKE_PRIORITY = {
    "retry": 0,
    "exec-event": 1,
}


@dataclass(slots=True)
class _PendingWake:
    session_id: str
    reason: str


class HeartbeatWakeManager:
    def __init__(self, *, scheduler: SessionScheduler) -> None:
        self._scheduler = scheduler
        self._pending: dict[str, _PendingWake] = {}
        self._running = False
        self._closed = False
        self._timer_task: asyncio.Task[None] | None = None
        self._timer_kind = ""

    async def stop(self) -> None:
        self._closed = True
        task = self._timer_task
        self._timer_task = None
        self._timer_kind = ""
        if task is not None:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        self._pending.clear()

    async def handle_request(self, request: HeartbeatWakeRequest) -> None:
        await self.request_now(session_id=request.session_id, reason=request.reason)

    async def request_now(self, *, session_id: str, reason: str = "exec-event") -> None:
        safe_session_id = str(session_id or "").strip()
        safe_reason = str(reason or "exec-event").strip() or "exec-event"
        if not safe_session_id:
            raise RuntimeError("session_id required")
        self._queue_pending(safe_session_id, safe_reason)
        logger.info(
            "[ExecNotify] wake queued: owner_session_id=%s heartbeat_reason=%s pending_count=%s",
            safe_session_id,
            safe_reason,
            len(self._pending),
        )
        self._ensure_scheduled(_RETRY_DELAY_S if safe_reason == "retry" else _NORMAL_DELAY_S, safe_reason)

    def _queue_pending(self, session_id: str, reason: str) -> None:
        next_wake = _PendingWake(session_id=session_id, reason=reason)
        previous = self._pending.get(session_id)
        if previous is None:
            self._pending[session_id] = next_wake
            return
        if _WAKE_PRIORITY.get(next_wake.reason, 0) >= _WAKE_PRIORITY.get(previous.reason, 0):
            logger.info(
                "[ExecNotify] wake deduped: owner_session_id=%s previous_reason=%s next_reason=%s",
                session_id,
                previous.reason,
                next_wake.reason,
            )
            self._pending[session_id] = next_wake

    def _ensure_scheduled(self, delay_s: float, kind: str) -> None:
        if self._closed:
            return
        if self._timer_task is not None and not self._timer_task.done():
            if self._timer_kind == "retry":
                return
            if kind == "retry":
                return
            return
        self._timer_kind = "retry" if kind == "retry" else "normal"
        logger.info(
            "[ExecNotify] wake timer scheduled: kind=%s delay_s=%.2f pending_count=%s",
            self._timer_kind,
            float(delay_s),
            len(self._pending),
        )
        self._timer_task = asyncio.create_task(
            self._run_after_delay(float(delay_s)),
            name=f"heartbeat-wake:{self._timer_kind}",
        )

    async def _run_after_delay(self, delay_s: float) -> None:
        try:
            await asyncio.sleep(max(0.0, float(delay_s)))
        except asyncio.CancelledError:
            return
        finally:
            if self._timer_task is not None and self._timer_task.done():
                self._timer_task = None

        self._timer_task = None
        self._timer_kind = ""
        if self._closed:
            return
        if self._running:
            self._ensure_scheduled(_NORMAL_DELAY_S, "normal")
            return
        await self._run_batch()

    async def _run_batch(self) -> None:
        if self._closed or self._running:
            return
        batch = list(self._pending.values())
        if not batch:
            return
        self._pending.clear()
        self._running = True
        logger.info("[ExecNotify] wake batch start: count=%s", len(batch))
        try:
            for wake in batch:
                if not await has_agent_session_pending_events(wake.session_id):
                    logger.info(
                        "[ExecNotify] wake dropped: owner_session_id=%s heartbeat_reason=%s reason=no_pending_events",
                        wake.session_id,
                        wake.reason,
                    )
                    continue
                if self._scheduler.has_inflight_work(wake.session_id):
                    logger.info(
                        "[ExecNotify] wake deferred: owner_session_id=%s heartbeat_reason=%s reason=session_busy",
                        wake.session_id,
                        wake.reason,
                    )
                    self._queue_pending(wake.session_id, "retry")
                    continue
                session = await load_agent_session(wake.session_id)
                if session is None:
                    logger.warning(
                        "[ExecNotify] wake dropped: owner_session_id=%s heartbeat_reason=%s reason=session_missing",
                        wake.session_id,
                        wake.reason,
                    )
                    continue
                job = AgentJob(
                    job_id=f"heartbeat-{wake.session_id}-{asyncio.get_running_loop().time():.6f}",
                    session_id=wake.session_id,
                    platform=str(getattr(session, "platform", "") or "").strip(),
                    connector_key=str(getattr(session, "connector_key", "") or "").strip(),
                    user_id=str(getattr(session, "owner_user_id", "") or "").strip(),
                    conversation_id=str(getattr(session, "conversation_id", "") or "").strip(),
                    is_group=bool(str(getattr(session, "conversation_type", "") or "").strip() == "2"),
                    message_id="",
                    user_input="",
                    job_kind="heartbeat",
                    sender_nick=str(getattr(session, "sender_nick", "") or "").strip(),
                    raw_data={
                        "heartbeat_reason": wake.reason,
                    },
                    user_content_blocks=[],
                )
                await self._scheduler.enqueue(job)
                logger.info(
                    "[ExecNotify] heartbeat enqueued: owner_session_id=%s heartbeat_reason=%s job_id=%s",
                    wake.session_id,
                    wake.reason,
                    job.job_id,
                )
        finally:
            self._running = False
            logger.info("[ExecNotify] wake batch done: remaining_pending=%s", len(self._pending))
            if self._pending:
                next_kind = "retry" if all(item.reason == "retry" for item in self._pending.values()) else "normal"
                self._ensure_scheduled(_RETRY_DELAY_S if next_kind == "retry" else _NORMAL_DELAY_S, next_kind)
