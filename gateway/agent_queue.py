from __future__ import annotations

import asyncio

from gateway.models import InboundEvent


class AgentQueue:
    def __init__(self) -> None:
        self._queue: asyncio.Queue[InboundEvent] = asyncio.Queue()

    async def get(self) -> InboundEvent:
        return await self._queue.get()

    def put_nowait(self, event: InboundEvent) -> None:
        self._queue.put_nowait(event)

    def empty(self) -> bool:
        return self._queue.empty()

    def task_done(self) -> None:
        self._queue.task_done()
