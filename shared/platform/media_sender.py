"""MediaSender protocol for platform-specific file/image delivery."""
from __future__ import annotations

from typing import Protocol

from shared.db.shared_state_dto import CardContext


class MediaSender(Protocol):
    async def send_file(self, ctx: CardContext, path: str) -> bool:
        ...

    async def send_markdown_card(self, ctx: CardContext, markdown: str, *, title: str = "") -> bool:
        ...
