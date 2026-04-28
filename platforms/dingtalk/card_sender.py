"""DingTalk CardSender implementation.

Wraps the existing dingtalk_api.send_general_card / update_general_card
behind the platform-neutral CardSender protocol.
"""
from __future__ import annotations

from typing import Any

import shared.dingtalk.api as dingtalk_api
from shared.db.client import load_card_context
from shared.config import config
from shared.dingtalk.credentials import normalize_bot_name


class DingTalkCardSender:
    """CardSender for DingTalk — delegates to the existing API module."""

    async def send_card(
        self,
        ctx: Any,
        card_id: str,
        card_params: dict[str, Any],
    ) -> str:
        raw_data = getattr(ctx, "raw_data", {}) or {}
        await dingtalk_api.send_general_card(
            raw_data=raw_data,
            out_track_id=card_id,
            card_template_id=config.GENERAL_CARD_TEMPLATE_ID,
            card_params=card_params,
        )
        return card_id

    async def update_card(
        self,
        card_id: str,
        card_params: dict[str, Any],
    ) -> None:
        bot_name = "agent"
        ctx = await load_card_context(card_id)
        if ctx is not None:
            bot_name = normalize_bot_name(ctx.connector_key or dict(ctx.extra_data or {}).get("bot_name"))
        await dingtalk_api.update_general_card(
            out_track_id=card_id,
            card_params=card_params,
            bot_name=bot_name,
        )
