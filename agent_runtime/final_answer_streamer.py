from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from typing import Awaitable, Callable
from uuid import uuid4

from shared.llm.events import LLMStreamEvent
from shared.logging import logger

from .tool_display import build_tool_display_step, sanitize_tool_steps


StreamEmitter = Callable[..., Awaitable[None]]


@dataclass(frozen=True, slots=True)
class _StreamSnapshot:
    content: str
    thinking: str
    redacted_thinking_count: int
    thinking_elapsed_ms: int
    tool_pending: bool
    tool_elapsed_ms: int
    tool_steps: list[dict[str, object]]


class FinalAnswerStreamer:
    def __init__(
        self,
        *,
        session_id: str,
        response_route_id: str,
        emit_stream: StreamEmitter,
        min_interval_ms: int = 150,
        emit_id: str = "",
    ) -> None:
        self.session_id = str(session_id or "").strip()
        self.response_route_id = str(response_route_id or "").strip()
        self.emit_id = str(emit_id or "").strip() or uuid4().hex
        self._emit_stream = emit_stream
        self._min_interval_s = max(0.0, int(min_interval_ms or 0) / 1000.0)
        self._lock = asyncio.Lock()
        self._sender_wakeup = asyncio.Event()
        self._sender_task: asyncio.Task[None] | None = None
        self._buffer = ""
        self._thinking_buffer = ""
        self._redacted_thinking_count = 0
        self._thinking_started_at: float | None = None
        self._thinking_elapsed_ms = 0
        self._tool_pending = False
        self._tool_started_at: float | None = None
        self._tool_elapsed_ms = 0
        self._tool_steps: list[dict[str, object]] = []
        self._last_sent_content = ""
        self._last_sent_thinking = ""
        self._last_sent_redacted_thinking_count = 0
        self._last_sent_thinking_elapsed_ms = 0
        self._last_sent_tool_pending = False
        self._last_sent_tool_elapsed_ms = 0
        self._last_sent_tool_steps: list[dict[str, object]] = []
        self._last_emit_at = 0.0
        # This is the upstream event order for gateway dedupe, not the Feishu CardKit sequence.
        self._seq = 0
        self._closed = False
        self._delivered_any = False
        self._terminal_state = ""

    @property
    def has_content(self) -> bool:
        return bool(
            self._buffer
            or self._last_sent_content
            or self._thinking_buffer
            or self._last_sent_thinking
            or self._redacted_thinking_count
            or self._last_sent_redacted_thinking_count
            or self._tool_pending
            or self._last_sent_tool_pending
            or self._tool_steps
            or self._last_sent_tool_steps
        )

    @property
    def delivered_any(self) -> bool:
        return self._delivered_any

    async def push_delta(self, text_delta: str) -> None:
        safe_delta = str(text_delta or "")
        if not safe_delta:
            return
        async with self._lock:
            if self._closed or self._terminal_state:
                return
            self._buffer += safe_delta
            self._ensure_sender_locked()
            self._sender_wakeup.set()

    async def push_event(self, event: LLMStreamEvent) -> None:
        event_type = str(getattr(event, "event_type", "") or "").strip()
        answer_delta = ""
        thinking_delta = ""
        redacted_delta = 0
        if event_type == "text_delta":
            answer_delta = str(getattr(event, "text", "") or "")
        elif event_type == "thinking_delta":
            thinking_delta = str(getattr(event, "thinking_text", "") or getattr(event, "text", "") or "")
        elif event_type == "redacted_thinking":
            redacted_delta = 1
        else:
            return
        if not answer_delta and not thinking_delta and redacted_delta <= 0:
            return
        async with self._lock:
            if self._closed or self._terminal_state:
                return
            if thinking_delta or redacted_delta > 0:
                self._start_thinking_timer_locked()
            if answer_delta:
                self._finish_thinking_timer_locked()
            self._buffer += answer_delta
            self._thinking_buffer += thinking_delta
            self._redacted_thinking_count += redacted_delta
            self._ensure_sender_locked()
            self._sender_wakeup.set()

    async def start_tool_pending(self) -> None:
        async with self._lock:
            if self._closed or self._terminal_state or self._tool_steps:
                return
            if self._tool_pending:
                return
            self._tool_pending = True
            self._ensure_sender_locked()
            self._sender_wakeup.set()

    async def push_tool_start(
        self,
        *,
        tool_call_id: str,
        tool_name: str,
        arguments: dict[str, object] | None = None,
    ) -> None:
        async with self._lock:
            if self._closed or self._terminal_state:
                return
            self._start_tool_timer_locked()
            self._tool_pending = False
            self._upsert_tool_step_locked(
                build_tool_display_step(
                    tool_call_id=tool_call_id,
                    tool_name=tool_name,
                    arguments=dict(arguments or {}),
                    status="running",
                    duration_ms=0,
                )
            )
            self._ensure_sender_locked()
            self._sender_wakeup.set()

    async def push_tool_finish(
        self,
        *,
        tool_call_id: str,
        tool_name: str,
        arguments: dict[str, object] | None = None,
        status: str,
        duration_ms: int = 0,
    ) -> None:
        safe_status = str(status or "").strip()
        if safe_status not in {"success", "error"}:
            safe_status = "error"
        safe_duration_ms = max(0, int(duration_ms or 0))
        async with self._lock:
            if self._closed or self._terminal_state:
                return
            self._finish_tool_timer_locked()
            self._tool_pending = False
            self._upsert_tool_step_locked(
                build_tool_display_step(
                    tool_call_id=tool_call_id,
                    tool_name=tool_name,
                    arguments=dict(arguments or {}),
                    status=safe_status,
                    duration_ms=safe_duration_ms,
                )
            )
            self._ensure_sender_locked()
            self._sender_wakeup.set()

    async def finish(self, final_text: str) -> None:
        safe_text = str(final_text or "").strip()
        async with self._lock:
            if self._closed:
                return
            accumulated = self._buffer or self._last_sent_content
            if accumulated and safe_text:
                self._buffer = accumulated if len(accumulated) >= len(safe_text) else safe_text
            else:
                self._buffer = accumulated or safe_text
            self._finish_thinking_timer_locked()
            self._finish_tool_timer_locked()
            self._tool_pending = False
            self._finalize_running_tools_locked()
            self._terminal_state = "final"
            self._ensure_sender_locked()
            self._sender_wakeup.set()
            task = self._sender_task
        if task is not None and task is not asyncio.current_task():
            await task

    async def fail(self, message: str) -> None:
        safe_message = str(message or "").strip()
        async with self._lock:
            if self._closed:
                return
            content = self._buffer or self._last_sent_content or safe_message
            self._buffer = content
            self._finish_thinking_timer_locked()
            self._finish_tool_timer_locked()
            self._tool_pending = False
            self._finalize_running_tools_locked()
            self._terminal_state = "error"
            self._ensure_sender_locked()
            self._sender_wakeup.set()
            task = self._sender_task
        if task is not None and task is not asyncio.current_task():
            await task

    async def cancel(self) -> None:
        async with self._lock:
            if self._closed:
                return
            self._finish_thinking_timer_locked()
            self._finish_tool_timer_locked()
            self._tool_pending = False
            self._finalize_running_tools_locked()
            self._buffer = self._last_sent_content
            if self._delivered_any:
                self._last_sent_thinking_elapsed_ms = max(
                    self._last_sent_thinking_elapsed_ms,
                    self._thinking_elapsed_ms,
                )
                self._last_sent_tool_elapsed_ms = max(
                    self._last_sent_tool_elapsed_ms,
                    self._tool_elapsed_ms,
                )
            self._terminal_state = "cancel"
            self._ensure_sender_locked()
            self._sender_wakeup.set()
            task = self._sender_task
        if task is not None and task is not asyncio.current_task():
            await task

    def _ensure_sender_locked(self) -> None:
        if self._sender_task is None or self._sender_task.done():
            self._sender_task = asyncio.create_task(self._sender_loop())

    def _start_thinking_timer_locked(self) -> None:
        if self._buffer or self._last_sent_content:
            return
        if self._thinking_started_at is None and self._thinking_elapsed_ms <= 0:
            self._thinking_started_at = time.monotonic()

    def _finish_thinking_timer_locked(self) -> None:
        if self._thinking_started_at is None or self._thinking_elapsed_ms > 0:
            return
        elapsed_s = max(0.0, time.monotonic() - self._thinking_started_at)
        self._thinking_elapsed_ms = max(0, int(round(elapsed_s * 1000)))

    def _start_tool_timer_locked(self) -> None:
        if self._tool_started_at is None and self._tool_elapsed_ms <= 0:
            self._tool_started_at = time.monotonic()
        self._update_tool_elapsed_locked()

    def _update_tool_elapsed_locked(self) -> None:
        if self._tool_started_at is None:
            return
        elapsed_s = max(0.0, time.monotonic() - self._tool_started_at)
        self._tool_elapsed_ms = max(self._tool_elapsed_ms, int(round(elapsed_s * 1000)))

    def _finish_tool_timer_locked(self) -> None:
        self._update_tool_elapsed_locked()

    def _upsert_tool_step_locked(self, step: dict[str, object]) -> None:
        safe_step = sanitize_tool_steps([step])[0]
        step_id = str(safe_step.get("id") or "").strip()
        for index, current in enumerate(self._tool_steps):
            if step_id and str(current.get("id") or "").strip() == step_id:
                self._tool_steps[index] = safe_step
                return
        self._tool_steps.append(safe_step)

    def _finalize_running_tools_locked(self) -> None:
        finalized: list[dict[str, object]] = []
        for raw_step in self._tool_steps:
            step = dict(raw_step)
            if str(step.get("status") or "").strip() == "running":
                step["status"] = "error"
                step["duration_ms"] = max(0, int(step.get("duration_ms") or 0), int(self._tool_elapsed_ms or 0))
            finalized.append(step)
        self._tool_steps = sanitize_tool_steps(finalized)

    async def _sender_loop(self) -> None:
        while True:
            await self._sender_wakeup.wait()
            self._sender_wakeup.clear()
            while True:
                action = await self._next_sender_action()
                if action is None:
                    break
                state, snapshot, close_after, delay_s = action
                if delay_s > 0:
                    await asyncio.sleep(delay_s)
                    continue
                await self._emit_snapshot(state, snapshot)
                if close_after:
                    async with self._lock:
                        self._closed = True
                    return

    async def _next_sender_action(self) -> tuple[str, _StreamSnapshot, bool, float] | None:
        async with self._lock:
            if self._closed:
                return None
            terminal_state = self._terminal_state
            snapshot = self._current_snapshot_locked()
            if terminal_state == "cancel":
                if self._delivered_any and self._has_snapshot(snapshot):
                    return ("final", snapshot, True, 0.0)
                self._closed = True
                return None
            if terminal_state in {"final", "error"}:
                if terminal_state == "final" and self._has_snapshot(snapshot) and self._snapshot_changed_locked(snapshot):
                    return ("delta", snapshot, False, 0.0)
                return (terminal_state, snapshot, True, 0.0)
            if not self._has_snapshot(snapshot) or not self._snapshot_changed_locked(snapshot):
                return None
            elapsed = time.monotonic() - self._last_emit_at
            delay_s = max(0.0, self._min_interval_s - elapsed)
            if delay_s > 0:
                return ("delta", snapshot, False, delay_s)
            return ("delta", snapshot, False, 0.0)

    def _current_snapshot_locked(self) -> _StreamSnapshot:
        return _StreamSnapshot(
            content=str(self._buffer or ""),
            thinking=str(self._thinking_buffer or ""),
            redacted_thinking_count=max(0, int(self._redacted_thinking_count or 0)),
            thinking_elapsed_ms=max(0, int(self._thinking_elapsed_ms or 0)),
            tool_pending=bool(self._tool_pending and not self._tool_steps),
            tool_elapsed_ms=max(0, int(self._tool_elapsed_ms or 0)),
            tool_steps=sanitize_tool_steps(self._tool_steps),
        )

    @staticmethod
    def _has_snapshot(snapshot: _StreamSnapshot) -> bool:
        return bool(
            snapshot.content
            or snapshot.thinking
            or snapshot.redacted_thinking_count > 0
            or snapshot.tool_pending
            or snapshot.tool_steps
        )

    def _snapshot_changed_locked(self, snapshot: _StreamSnapshot) -> bool:
        return (
            snapshot.content != self._last_sent_content
            or snapshot.thinking != self._last_sent_thinking
            or snapshot.redacted_thinking_count != self._last_sent_redacted_thinking_count
            or snapshot.thinking_elapsed_ms != self._last_sent_thinking_elapsed_ms
            or snapshot.tool_pending != self._last_sent_tool_pending
            or snapshot.tool_elapsed_ms != self._last_sent_tool_elapsed_ms
            or sanitize_tool_steps(snapshot.tool_steps) != sanitize_tool_steps(self._last_sent_tool_steps)
        )

    async def _emit_snapshot(self, state: str, snapshot: _StreamSnapshot) -> None:
        safe_content = str(snapshot.content or "")
        safe_thinking = str(snapshot.thinking or "")
        safe_redacted_thinking_count = max(0, int(snapshot.redacted_thinking_count or 0))
        safe_thinking_elapsed_ms = max(0, int(snapshot.thinking_elapsed_ms or 0))
        safe_tool_pending = bool(snapshot.tool_pending and not snapshot.tool_steps)
        safe_tool_elapsed_ms = max(0, int(snapshot.tool_elapsed_ms or 0))
        safe_tool_steps = sanitize_tool_steps(snapshot.tool_steps)
        async with self._lock:
            self._seq += 1
            seq = self._seq
            previous_emit_at = self._last_emit_at
            now = time.monotonic()
            interval_ms = int((now - previous_emit_at) * 1000) if previous_emit_at else 0
            self._last_sent_content = safe_content
            self._last_sent_thinking = safe_thinking
            self._last_sent_redacted_thinking_count = safe_redacted_thinking_count
            self._last_sent_thinking_elapsed_ms = safe_thinking_elapsed_ms
            self._last_sent_tool_pending = safe_tool_pending
            self._last_sent_tool_elapsed_ms = safe_tool_elapsed_ms
            self._last_sent_tool_steps = list(safe_tool_steps)
            self._last_emit_at = now
        logger.info(
            "[FinalAnswerStreamer] emit: session_id=%s state=%s seq=%d content_len=%d thinking_len=%d redacted_thinking_count=%d thinking_elapsed_ms=%d tool_pending=%s tool_steps=%d tool_elapsed_ms=%d interval_ms=%d",
            self.session_id,
            state,
            seq,
            len(safe_content),
            len(safe_thinking),
            safe_redacted_thinking_count,
            safe_thinking_elapsed_ms,
            safe_tool_pending,
            len(safe_tool_steps),
            safe_tool_elapsed_ms,
            interval_ms,
        )
        try:
            tool_kwargs = {}
            if safe_tool_pending or safe_tool_steps or safe_tool_elapsed_ms > 0:
                tool_kwargs = {
                    "tool_pending": safe_tool_pending,
                    "tool_elapsed_ms": safe_tool_elapsed_ms,
                    "tool_steps": safe_tool_steps,
                }
            await self._emit_stream(
                self.session_id,
                self.response_route_id,
                "final_answer",
                state,
                seq,
                safe_content,
                self.emit_id,
                thinking=safe_thinking,
                redacted_thinking_count=safe_redacted_thinking_count,
                thinking_elapsed_ms=safe_thinking_elapsed_ms,
                **tool_kwargs,
            )
        except Exception as error:
            logger.warning(
                "[FinalAnswerStreamer] emit failed: session_id=%s state=%s seq=%d error=%s",
                self.session_id,
                state,
                seq,
                error,
            )
            return
        async with self._lock:
            self._delivered_any = True
