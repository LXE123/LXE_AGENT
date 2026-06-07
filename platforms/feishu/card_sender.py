"""Feishu CardSender implementation."""
from __future__ import annotations

import json
from types import SimpleNamespace
from typing import Any

from shared.db.client import load_response_route_context, save_response_route_delivery_handle
from shared.infra.net import HttpSessionPurpose, get_aiohttp_session
from shared.logging import logger

from .auth import token_manager
from .card_builder import card_params_to_feishu_card
from .config import FEISHU_API_HOST


class FeishuCardSender:
    @staticmethod
    async def _read_response_json(response, *, operation: str, url: str) -> dict[str, Any]:
        content_type = str(response.headers.get("Content-Type") or "").strip().lower()
        if "application/json" in content_type:
            return dict(await response.json() or {})

        body = (await response.text()).strip()
        preview = body[:300]
        raise RuntimeError(
            f"[Feishu] {operation} failed: status={response.status} "
            f"content_type={content_type or '<empty>'} url={url} body={preview}"
        )

    async def send_card(
        self,
        ctx: Any,
        response_route_id: str,
        card_params: dict[str, Any],
    ) -> str:
        token = await token_manager.get_token()
        card_json = card_params_to_feishu_card(card_params)
        content = json.dumps(card_json, ensure_ascii=False)

        raw_data: dict[str, Any] = getattr(ctx, "raw_data", {}) or {}
        chat_id = str(
            raw_data.get("chat_id")
            or raw_data.get("conversationId")
            or getattr(ctx, "conversation_id", "")
        ).strip()
        reply_to_message_id = str(
            raw_data.get("source_message_id")
            or raw_data.get("message_id")
            or getattr(ctx, "message_id", "")
        ).strip()
        session = get_aiohttp_session(HttpSessionPurpose.EXTERNAL)
        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json; charset=utf-8",
        }
        if reply_to_message_id:
            url = f"{FEISHU_API_HOST}/im/v1/messages/{reply_to_message_id}/reply"
            body: dict[str, Any] = {
                "msg_type": "interactive",
                "content": content,
            }
        else:
            url = f"{FEISHU_API_HOST}/im/v1/messages?receive_id_type=chat_id"
            body = {
                "receive_id": chat_id,
                "msg_type": "interactive",
                "content": content,
            }

        response = await session.post(url, json=body, headers=headers)
        data = await self._read_response_json(response, operation="send_card", url=url)
        code = data.get("code", -1)
        if code != 0:
            raise RuntimeError(f"[Feishu] send_card failed: resp={data}")

        platform_message_id = str((data.get("data") or {}).get("message_id") or "").strip()
        if platform_message_id:
            await save_response_route_delivery_handle(
                response_route_id,
                platform="feishu",
                platform_message_id=platform_message_id,
            )
        logger.info(
            "[Feishu] card sent: response_route_id=%s feishu_msg_id=%s",
            response_route_id,
            platform_message_id,
        )
        return platform_message_id or response_route_id

    async def update_card(
        self,
        response_route_id: str,
        card_params: dict[str, Any],
    ) -> None:
        route_ctx = await load_response_route_context(response_route_id)
        if route_ctx is None:
            logger.warning("[Feishu] update_card: missing response route for response_route_id=%s", response_route_id)
            return

        platform_message_id = str(route_ctx.platform_message_id or "").strip()
        if not platform_message_id:
            logger.warning(
                "[Feishu] update_card: missing platform_message_id for response_route_id=%s",
                response_route_id,
            )
            return

        token = await token_manager.get_token()
        card_json = card_params_to_feishu_card(card_params)
        content = json.dumps(card_json, ensure_ascii=False)
        session = get_aiohttp_session(HttpSessionPurpose.EXTERNAL)
        response = await session.patch(
            f"{FEISHU_API_HOST}/im/v1/messages/{platform_message_id}",
            json={"content": content},
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json; charset=utf-8",
            },
        )
        data = await self._read_response_json(
            response,
            operation="update_card",
            url=f"{FEISHU_API_HOST}/im/v1/messages/{platform_message_id}",
        )
        code = data.get("code", -1)
        if code != 0:
            logger.warning("[Feishu] update_card failed: response_route_id=%s resp=%s", response_route_id, data)


def build_markdown_card_context(route_ctx) -> Any:
    return SimpleNamespace(
        platform="feishu",
        response_route_id="",
        user_id=route_ctx.owner_user_id,
        conversation_id=route_ctx.conversation_id or "",
        is_group=str(route_ctx.conversation_type or "") == "2",
        sender_nick=route_ctx.sender_nick or "",
        message_id="",
        raw_data={
            "platform": "feishu",
            "chat_id": str(route_ctx.conversation_id or "").strip(),
            "source_message_id": str(dict(route_ctx.extra_data or {}).get("source_message_id") or "").strip(),
        },
    )
