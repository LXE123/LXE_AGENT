from __future__ import annotations

from typing import Any

from shared.db.client import save_response_route_patch
from shared.logging import logger

from .api_client import FeishuApiClient, api_client

_TYPING_EMOJI_TYPE = "Typing"
_TYPING_MESSAGE_ID_KEY = "typing_message_id"
_TYPING_REACTION_ID_KEY = "typing_reaction_id"


def _source_message_id(ctx: Any) -> str:
    extra_data = dict(getattr(ctx, "extra_data", {}) or {})
    raw_data = dict(getattr(ctx, "raw_data", {}) or {})
    return str(
        extra_data.get("source_message_id")
        or raw_data.get("source_message_id")
        or raw_data.get("message_id")
        or getattr(ctx, "message_id", "")
        or ""
    ).strip()


class FeishuTypingIndicator:
    def __init__(self, *, client: FeishuApiClient | None = None) -> None:
        self._client = client or api_client

    async def handle(self, ctx: Any, response_route_id: str, *, operation: str) -> None:
        safe_operation = str(operation or "").strip()
        if safe_operation == "start":
            await self.start(ctx, response_route_id)
            return
        if safe_operation == "stop":
            await self.stop(ctx, response_route_id)
            return
        logger.warning("[FeishuTyping] unsupported operation: %s", safe_operation or "<empty>")

    async def start(self, ctx: Any, response_route_id: str) -> None:
        safe_response_route_id = str(response_route_id or "").strip()
        message_id = _source_message_id(ctx)
        if not safe_response_route_id or not message_id:
            logger.info(
                "[FeishuTyping] skip start: response_route_id=%s message_id=%s",
                safe_response_route_id or "<empty>",
                message_id or "<empty>",
            )
            return

        extra_data = dict(getattr(ctx, "extra_data", {}) or {})
        existing_reaction_id = str(extra_data.get(_TYPING_REACTION_ID_KEY) or "").strip()
        existing_message_id = str(extra_data.get(_TYPING_MESSAGE_ID_KEY) or "").strip()
        if existing_reaction_id and existing_message_id == message_id:
            logger.info("[FeishuTyping] typing indicator already active: response_route_id=%s", safe_response_route_id)
            return

        try:
            reaction_id = await self._client.add_message_reaction(message_id, _TYPING_EMOJI_TYPE)
        except Exception as exc:
            logger.warning(
                "[FeishuTyping] add typing indicator failed: response_route_id=%s message_id=%s error=%s",
                safe_response_route_id,
                message_id,
                exc,
            )
            return

        await self._save_patch_best_effort(
            safe_response_route_id,
            {
                _TYPING_MESSAGE_ID_KEY: message_id,
                _TYPING_REACTION_ID_KEY: reaction_id,
            },
        )
        logger.info("[FeishuTyping] typing indicator added: response_route_id=%s", safe_response_route_id)

    async def stop(self, ctx: Any, response_route_id: str) -> None:
        safe_response_route_id = str(response_route_id or "").strip()
        if not safe_response_route_id:
            return

        extra_data = dict(getattr(ctx, "extra_data", {}) or {})
        message_id = str(extra_data.get(_TYPING_MESSAGE_ID_KEY) or "").strip() or _source_message_id(ctx)
        reaction_id = str(extra_data.get(_TYPING_REACTION_ID_KEY) or "").strip()
        if not reaction_id:
            await self._clear_state_best_effort(safe_response_route_id)
            return

        try:
            await self._client.delete_message_reaction(message_id, reaction_id)
            logger.info("[FeishuTyping] typing indicator removed: response_route_id=%s", safe_response_route_id)
        except Exception as exc:
            logger.warning(
                "[FeishuTyping] remove typing indicator failed: response_route_id=%s message_id=%s error=%s",
                safe_response_route_id,
                message_id,
                exc,
            )
        finally:
            await self._clear_state_best_effort(safe_response_route_id)

    async def _clear_state_best_effort(self, response_route_id: str) -> None:
        await self._save_patch_best_effort(
            response_route_id,
            {
                _TYPING_MESSAGE_ID_KEY: "",
                _TYPING_REACTION_ID_KEY: "",
            },
        )

    @staticmethod
    async def _save_patch_best_effort(response_route_id: str, patch: dict[str, str]) -> None:
        try:
            await save_response_route_patch(response_route_id, patch)
        except Exception as exc:
            logger.warning("[FeishuTyping] save typing state failed: response_route_id=%s error=%s", response_route_id, exc)


__all__ = ["FeishuTypingIndicator"]
