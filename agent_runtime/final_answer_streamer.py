from __future__ import annotations

import asyncio
import time
from typing import Awaitable, Callable
from uuid import uuid4

from shared.logging import logger


StreamEmitter = Callable[[str, str, int, str, str], Awaitable[None]]


class FinalAnswerStreamer:
    def __init__(
        self,
        *,
        session_id: str,
        emit_stream: StreamEmitter,
        min_interval_ms: int = 150,
        emit_id: str = "",
    ) -> None:
        self.session_id = str(session_id or "").strip()
        self.emit_id = str(emit_id or "").strip() or uuid4().hex
        self._emit_stream = emit_stream
        self._min_interval_s = max(0.0, int(min_interval_ms or 0) / 1000.0)
        self._lock = asyncio.Lock()
        self._pending_task: asyncio.Task[None] | None = None
        self._buffer = ""
        self._last_sent_content = ""
        self._last_emit_at = 0.0
        # This is the upstream event order for gateway dedupe, not the Feishu CardKit sequence.
        self._seq = 0
        self._closed = False
        self._delivered_any = False

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
            if self._closed:
                return
            self._buffer += safe_delta
            elapsed = time.monotonic() - self._last_emit_at
            if elapsed >= self._min_interval_s and self._pending_task is None:
                await self._flush_locked("delta", force=True)
                return
            if self._pending_task is None:
                delay = max(0.0, self._min_interval_s - elapsed)
                self._pending_task = asyncio.create_task(self._delayed_flush(delay))

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
            await self._cancel_pending_locked()
            if self._buffer != self._last_sent_content:
                await self._flush_locked("delta", force=True)
            await self._emit_locked("final", self._buffer)
            self._closed = True

    async def fail(self, message: str) -> None:
        safe_message = str(message or "").strip()
        async with self._lock:
            if self._closed:
                return
            await self._cancel_pending_locked()
            content = self._buffer or self._last_sent_content or safe_message
            self._buffer = content
            await self._emit_locked("error", content)
            self._closed = True

    async def cancel(self) -> None:
        async with self._lock:
            if self._closed:
                return
            await self._cancel_pending_locked()
            content = self._last_sent_content
            self._buffer = content
            if self._delivered_any and content:
                await self._emit_locked("final", content)
            self._closed = True

    async def _delayed_flush(self, delay_s: float) -> None:
        try:
            await asyncio.sleep(delay_s)
            async with self._lock:
                self._pending_task = None
                if self._closed:
                    return
                await self._flush_locked("delta", force=False)
        except asyncio.CancelledError:
            raise

    async def _cancel_pending_locked(self) -> None:
        task = self._pending_task
        self._pending_task = None
        if task is None:
            return
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    async def _flush_locked(self, state: str, *, force: bool) -> None:
        if not self._buffer:
            return
        if not force and self._buffer == self._last_sent_content:
            return
        await self._emit_locked(state, self._buffer)

    async def _emit_locked(self, state: str, content: str) -> None:
        self._seq += 1
        self._last_sent_content = str(content or "")
        self._last_emit_at = time.monotonic()
        try:
            await self._emit_stream(
                self.session_id,
                "final_answer",
                state,
                self._seq,
                self._last_sent_content,
                self.emit_id,
            )
            self._delivered_any = True
        except Exception as error:
            logger.warning(
                "[FinalAnswerStreamer] emit failed: session_id=%s state=%s seq=%d error=%s",
                self.session_id,
                state,
                self._seq,
                error,
            )
