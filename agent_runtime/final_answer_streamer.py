from __future__ import annotations

import asyncio
import time
from typing import Awaitable, Callable
from uuid import uuid4

from shared.logging import logger


StreamEmitter = Callable[[str, str, str, str, int, str, str], Awaitable[None]]


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
        self._last_sent_content = ""
        self._last_emit_at = 0.0
        # This is the upstream event order for gateway dedupe, not the Feishu CardKit sequence.
        self._seq = 0
        self._closed = False
        self._delivered_any = False
        self._terminal_state = ""

    @property
    def has_content(self) -> bool:
        return bool(self._buffer or self._last_sent_content)

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
            self._buffer = self._last_sent_content
            self._terminal_state = "cancel"
            self._ensure_sender_locked()
            self._sender_wakeup.set()
            task = self._sender_task
        if task is not None and task is not asyncio.current_task():
            await task

    def _ensure_sender_locked(self) -> None:
        if self._sender_task is None or self._sender_task.done():
            self._sender_task = asyncio.create_task(self._sender_loop())

    async def _sender_loop(self) -> None:
        while True:
            await self._sender_wakeup.wait()
            self._sender_wakeup.clear()
            while True:
                action = await self._next_sender_action()
                if action is None:
                    break
                state, content, close_after, delay_s = action
                if delay_s > 0:
                    await asyncio.sleep(delay_s)
                    continue
                await self._emit_snapshot(state, content)
                if close_after:
                    async with self._lock:
                        self._closed = True
                    return

    async def _next_sender_action(self) -> tuple[str, str, bool, float] | None:
        async with self._lock:
            if self._closed:
                return None
            terminal_state = self._terminal_state
            if terminal_state == "cancel":
                if self._delivered_any and self._last_sent_content:
                    return ("final", self._last_sent_content, True, 0.0)
                self._closed = True
                return None
            if terminal_state in {"final", "error"}:
                if terminal_state == "final" and self._buffer and self._buffer != self._last_sent_content:
                    return ("delta", self._buffer, False, 0.0)
                content = self._buffer or self._last_sent_content
                return (terminal_state, content, True, 0.0)
            if not self._buffer or self._buffer == self._last_sent_content:
                return None
            elapsed = time.monotonic() - self._last_emit_at
            delay_s = max(0.0, self._min_interval_s - elapsed)
            if delay_s > 0:
                return ("delta", "", False, delay_s)
            return ("delta", self._buffer, False, 0.0)

    async def _emit_snapshot(self, state: str, content: str) -> None:
        safe_content = str(content or "")
        async with self._lock:
            self._seq += 1
            seq = self._seq
            previous_emit_at = self._last_emit_at
            now = time.monotonic()
            interval_ms = int((now - previous_emit_at) * 1000) if previous_emit_at else 0
            self._last_sent_content = safe_content
            self._last_emit_at = now
        logger.info(
            "[FinalAnswerStreamer] emit: session_id=%s state=%s seq=%d content_len=%d interval_ms=%d",
            self.session_id,
            state,
            seq,
            len(safe_content),
            interval_ms,
        )
        try:
            await self._emit_stream(
                self.session_id,
                self.response_route_id,
                "final_answer",
                state,
                seq,
                safe_content,
                self.emit_id,
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
