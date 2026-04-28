"""CardSender protocol — the only thing agent_runtime needs to deliver cards."""
from __future__ import annotations

from typing import Any, Protocol


class CardSender(Protocol):
    async def send_card(
        self,
        ctx: Any,
        card_id: str,
        card_params: dict[str, Any],
    ) -> str:
        """Send a new card. Return a platform-side message/card identifier."""
        ...

    async def update_card(
        self,
        card_id: str,
        card_params: dict[str, Any],
    ) -> None:
        """Update an existing card by its card_id."""
        ...
