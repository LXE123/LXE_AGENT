from __future__ import annotations

import asyncio
from collections import defaultdict, deque
from typing import Awaitable, Callable

from shared.agent_ipc import AgentJob
from shared.logging import logger


JobExecutor = Callable[[AgentJob], Awaitable[None]]


class SessionScheduler:
    def __init__(self, *, executor: JobExecutor, max_concurrency: int) -> None:
        self._executor = executor
        self._max_concurrency = max(1, int(max_concurrency or 1))
        self._pending_by_session: dict[str, deque[AgentJob]] = defaultdict(deque)
        self._ready_sessions: deque[str] = deque()
        self._ready_set: set[str] = set()
        self._active_sessions: set[str] = set()
        self._running_tasks: set[asyncio.Task] = set()
        self._stopping = False

    async def enqueue(self, job: AgentJob, *, front: bool = False) -> None:
        session_id = str(job.session_id or "").strip()
        if not session_id:
            raise RuntimeError("session_id required")
        pending = self._pending_by_session[session_id]
        if front:
            pending.appendleft(job)
        else:
            pending.append(job)
        self._mark_ready(session_id)
        self._drain()

    def is_session_running(self, session_id: str) -> bool:
        return str(session_id or "").strip() in self._active_sessions

    def has_inflight_work(self, session_id: str) -> bool:
        safe_session_id = str(session_id or "").strip()
        if not safe_session_id:
            return False
        if safe_session_id in self._active_sessions:
            return True
        return bool(self._pending_by_session.get(safe_session_id))

    def has_inflight_jobs(self) -> bool:
        if self._running_tasks:
            return True
        return any(bool(pending) for pending in self._pending_by_session.values())

    async def stop(self, *, timeout_s: float = 3.0) -> None:
        self._stopping = True
        tasks = list(self._running_tasks)
        for task in tasks:
            task.cancel()
        try:
            if tasks:
                await asyncio.wait_for(
                    asyncio.gather(*tasks, return_exceptions=True),
                    timeout=max(0.1, float(timeout_s)),
                )
        except asyncio.TimeoutError:
            logger.warning(
                "[SessionScheduler] stop timed out after %.1fs; abandon %s running task(s)",
                float(timeout_s),
                len(tasks),
            )
        finally:
            self._running_tasks.clear()
            self._pending_by_session.clear()
            self._ready_sessions.clear()
            self._ready_set.clear()
            self._active_sessions.clear()

    def _mark_ready(self, session_id: str) -> None:
        if session_id in self._active_sessions or session_id in self._ready_set:
            return
        pending = self._pending_by_session.get(session_id)
        if not pending:
            return
        self._ready_sessions.append(session_id)
        self._ready_set.add(session_id)

    def _drain(self) -> None:
        if self._stopping:
            return
        while len(self._running_tasks) < self._max_concurrency and self._ready_sessions:
            session_id = self._ready_sessions.popleft()
            self._ready_set.discard(session_id)
            if session_id in self._active_sessions:
                continue
            pending = self._pending_by_session.get(session_id)
            if not pending:
                continue
            job = pending.popleft()
            if not pending:
                self._pending_by_session.pop(session_id, None)
            self._active_sessions.add(session_id)
            task = asyncio.create_task(self._run_job(job), name=f"agent-job:{session_id}:{job.job_id}")
            self._running_tasks.add(task)
            task.add_done_callback(self._on_task_done)

    async def _run_job(self, job: AgentJob) -> None:
        await self._executor(job)

    def _on_task_done(self, task: asyncio.Task) -> None:
        self._running_tasks.discard(task)
        session_id = ""
        try:
            name = task.get_name()
            if name.startswith("agent-job:"):
                parts = name.split(":", 2)
                if len(parts) >= 2:
                    session_id = parts[1]
        except Exception:
            session_id = ""
        try:
            error = task.exception()
        except asyncio.CancelledError:
            error = None
        except Exception:
            error = None
        if error is not None:
            logger.error("[SessionScheduler] job failed: session_id=%s error=%s", session_id, error, exc_info=error)
        if session_id:
            self._active_sessions.discard(session_id)
            self._mark_ready(session_id)
        self._drain()
