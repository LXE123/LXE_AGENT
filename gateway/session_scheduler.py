from __future__ import annotations

import asyncio
from collections import defaultdict, deque
import contextlib
from dataclasses import dataclass, field
import threading
import time
from typing import Awaitable, Callable
from uuid import uuid4

from shared.agent_io import AgentJob
from shared.logging import get_logger

logger = get_logger(__name__)


CancelHandle = Callable[[], None]


@dataclass(slots=True)
class ToolRunHandle:
    tool_call_id: str
    tool_name: str
    cancel_handle: CancelHandle | None = None
    started_at: float = field(default_factory=time.time)
    cleanup_state: str = "running"


@dataclass(slots=True)
class RunHandle:
    session_id: str
    job_id: str
    response_route_id: str = ""
    origin_job: AgentJob | None = None
    task: asyncio.Task | None = None
    cancel_event: asyncio.Event = field(default_factory=asyncio.Event)
    thread_cancel_event: threading.Event = field(default_factory=threading.Event)
    started_at: float = field(default_factory=time.time)
    cleanup_state: str = "running"
    active_tools: dict[str, ToolRunHandle] = field(default_factory=dict)
    _provider_cancel_handle: CancelHandle | None = field(default=None, init=False, repr=False)
    _steering_messages: list[dict[str, str]] = field(default_factory=list, init=False, repr=False)
    _lock: threading.RLock = field(default_factory=threading.RLock, init=False, repr=False)

    def push_steering(self, text: str, *, response_route_id: str = "", message_id: str = "") -> None:
        """Queue a user message to be injected at the next step boundary."""
        safe_text = str(text or "").strip()
        if not safe_text:
            return
        with self._lock:
            self._steering_messages.append(
                {
                    "text": safe_text,
                    "response_route_id": str(response_route_id or "").strip(),
                    "message_id": str(message_id or "").strip(),
                }
            )

    def drain_steering(self) -> list[dict[str, str]]:
        """Return and clear all queued steering messages (called from the loop)."""
        with self._lock:
            if not self._steering_messages:
                return []
            drained = list(self._steering_messages)
            self._steering_messages.clear()
        return drained

    def request_cancel(self) -> None:
        self.cancel_event.set()
        self.thread_cancel_event.set()
        with self._lock:
            provider_cancel_handle = self._provider_cancel_handle
            tool_cancel_handles = [
                handle.cancel_handle
                for handle in self.active_tools.values()
                if handle.cancel_handle is not None
            ]
        if provider_cancel_handle is not None:
            try:
                provider_cancel_handle()
            except Exception as exc:
                logger.warning(
                    "[SessionScheduler] provider cancel handle failed: session_id=%s job_id=%s error=%s",
                    self.session_id,
                    self.job_id,
                    exc,
                    exc_info=True,
                )
        for cancel_handle in tool_cancel_handles:
            try:
                cancel_handle()
            except Exception as exc:
                logger.warning(
                    "[SessionScheduler] tool cancel handle failed: session_id=%s job_id=%s error=%s",
                    self.session_id,
                    self.job_id,
                    exc,
                    exc_info=True,
                )

    @property
    def cancelled(self) -> bool:
        return self.cancel_event.is_set() or self.thread_cancel_event.is_set()

    def set_provider_cancel_handle(self, cancel_handle: CancelHandle | None) -> None:
        with self._lock:
            self._provider_cancel_handle = cancel_handle
            should_cancel = self.cancelled and cancel_handle is not None
        if should_cancel:
            try:
                cancel_handle()
            except Exception as exc:
                logger.warning(
                    "[SessionScheduler] provider cancel handle failed during registration: "
                    "session_id=%s job_id=%s error=%s",
                    self.session_id,
                    self.job_id,
                    exc,
                    exc_info=True,
                )

    def clear_provider_cancel_handle(self, cancel_handle: CancelHandle | None = None) -> None:
        with self._lock:
            if cancel_handle is None or self._provider_cancel_handle is cancel_handle:
                self._provider_cancel_handle = None

    def register_tool_run(
        self,
        tool_call_id: str,
        tool_name: str,
        cancel_handle: CancelHandle | None = None,
    ) -> None:
        safe_tool_call_id = str(tool_call_id or "").strip()
        if not safe_tool_call_id:
            return
        safe_tool_name = str(tool_name or "").strip()
        with self._lock:
            self.active_tools[safe_tool_call_id] = ToolRunHandle(
                tool_call_id=safe_tool_call_id,
                tool_name=safe_tool_name,
                cancel_handle=cancel_handle,
            )
            should_cancel = self.cancelled and cancel_handle is not None
        if should_cancel:
            try:
                cancel_handle()
            except Exception as exc:
                logger.warning(
                    "[SessionScheduler] tool cancel handle failed during registration: "
                    "session_id=%s job_id=%s tool_call_id=%s error=%s",
                    self.session_id,
                    self.job_id,
                    safe_tool_call_id,
                    exc,
                    exc_info=True,
                )

    def finish_tool_run(self, tool_call_id: str, *, cleanup_state: str = "done") -> None:
        safe_tool_call_id = str(tool_call_id or "").strip()
        if not safe_tool_call_id:
            return
        with self._lock:
            handle = self.active_tools.pop(safe_tool_call_id, None)
            if handle is not None:
                handle.cleanup_state = str(cleanup_state or "").strip() or "done"


JobExecutor = Callable[[AgentJob, RunHandle], Awaitable[None]]


class SessionScheduler:
    def __init__(self, *, executor: JobExecutor, max_concurrency: int) -> None:
        self._executor = executor
        self._max_concurrency = max(1, int(max_concurrency or 1))
        self._pending_by_session: dict[str, deque[AgentJob]] = defaultdict(deque)
        self._ready_sessions: deque[str] = deque()
        self._ready_set: set[str] = set()
        self._active_runs: dict[str, RunHandle] = {}
        self._task_sessions: dict[asyncio.Task, str] = {}
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
        return str(session_id or "").strip() in self._active_runs

    def active_run(self, session_id: str) -> RunHandle | None:
        return self._active_runs.get(str(session_id or "").strip())

    def request_stop(self, session_id: str) -> bool:
        handle = self.active_run(session_id)
        if handle is None:
            return False
        handle.request_cancel()
        logger.info(
            "[SessionScheduler] stop requested: session_id=%s job_id=%s",
            handle.session_id,
            handle.job_id,
        )
        return True

    def clear_pending(self, session_id: str) -> int:
        """Drop queued (not yet running) jobs for a session. Returns the number cleared."""
        safe_session_id = str(session_id or "").strip()
        if not safe_session_id:
            return 0
        pending = self._pending_by_session.pop(safe_session_id, None)
        cleared = len(pending) if pending else 0
        self._ready_set.discard(safe_session_id)
        with contextlib.suppress(ValueError):
            self._ready_sessions.remove(safe_session_id)
        if cleared:
            logger.info(
                "[SessionScheduler] pending jobs cleared: session_id=%s cleared=%s",
                safe_session_id,
                cleared,
            )
        return cleared

    def has_inflight_work(self, session_id: str) -> bool:
        safe_session_id = str(session_id or "").strip()
        if not safe_session_id:
            return False
        if safe_session_id in self._active_runs:
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
        for handle in self._active_runs.values():
            handle.cleanup_state = "stopped"
            handle.request_cancel()
        self._active_runs.clear()
        self._task_sessions.clear()

    def _mark_ready(self, session_id: str) -> None:
        if session_id in self._active_runs or session_id in self._ready_set:
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
            if session_id in self._active_runs:
                continue
            pending = self._pending_by_session.get(session_id)
            if not pending:
                continue
            job = pending.popleft()
            if not pending:
                self._pending_by_session.pop(session_id, None)
            handle = RunHandle(
                session_id=session_id,
                job_id=str(job.job_id or "").strip(),
                response_route_id=str(job.response_route_id or "").strip(),
                origin_job=job,
            )
            task = asyncio.create_task(self._run_job(job, handle), name=f"agent-job:{job.job_id}")
            handle.task = task
            self._active_runs[session_id] = handle
            self._task_sessions[task] = session_id
            self._running_tasks.add(task)
            task.add_done_callback(self._on_task_done)

    async def _run_job(self, job: AgentJob, handle: RunHandle) -> None:
        await self._executor(job, handle)

    def _on_task_done(self, task: asyncio.Task) -> None:
        self._running_tasks.discard(task)
        session_id = self._task_sessions.pop(task, "")
        try:
            error = task.exception()
        except asyncio.CancelledError:
            error = None
        except Exception:
            error = None
        if error is not None:
            logger.error("[SessionScheduler] job failed: session_id=%s error=%s", session_id, error, exc_info=error)
        if session_id:
            handle = self._active_runs.pop(session_id, None)
            if handle is not None:
                handle.cleanup_state = "done" if error is None else "error"
                self._requeue_leftover_steering(handle)
            self._mark_ready(session_id)
        self._drain()

    def _requeue_leftover_steering(self, handle: RunHandle) -> None:
        """turn 结束时仍未被消费的插话消息，重新入队成新 turn，避免丢失。

        被 /stop 取消的 run 例外：用户已叫停，剩余插话随之丢弃。
        """
        leftover = handle.drain_steering()
        if not leftover:
            return
        if handle.cancelled:
            logger.info(
                "[SessionScheduler] steering dropped after cancelled run: session_id=%s job_id=%s count=%s",
                handle.session_id,
                handle.job_id,
                len(leftover),
            )
            return
        origin = handle.origin_job
        if origin is None:
            logger.warning(
                "[SessionScheduler] cannot requeue steering, origin job missing: session_id=%s job_id=%s",
                handle.session_id,
                handle.job_id,
            )
            return
        text = "\n\n".join(
            part for part in (str(item.get("text") or "").strip() for item in leftover) if part
        )
        if not text:
            return
        last = leftover[-1]
        raw_data = {
            key: value
            for key, value in dict(origin.raw_data or {}).items()
            if key != "system_events"
        }
        job = AgentJob(
            job_id=uuid4().hex,
            session_id=origin.session_id,
            session_key=origin.session_key,
            response_route_id=str(last.get("response_route_id") or "").strip() or origin.response_route_id,
            user_id=origin.user_id,
            conversation_id=origin.conversation_id,
            is_group=origin.is_group,
            message_id=str(last.get("message_id") or "").strip(),
            user_input=text,
            job_kind="turn",
            sender_nick=origin.sender_nick,
            raw_data=raw_data,
            source=dict(origin.source or {}),
            user_content_blocks=[],
        )
        self._pending_by_session[job.session_id].appendleft(job)
        logger.info(
            "[SessionScheduler] leftover steering requeued as new turn: session_id=%s new_job_id=%s count=%s chars=%s",
            job.session_id,
            job.job_id,
            len(leftover),
            len(text),
        )
