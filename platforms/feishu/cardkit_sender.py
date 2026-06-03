from __future__ import annotations

import json
from typing import Any

from shared.db.client import save_card_delivery_handle, save_card_session_patch
from shared.infra.net import HttpSessionPurpose, get_aiohttp_session
from shared.logging import logger

from .auth import token_manager
from .config import FEISHU_API_HOST


_STREAM_ELEMENT_ID = "streaming_content"
_STREAM_CARD_TYPE = "card_json"


class FeishuCardKitError(RuntimeError):
    def __init__(
        self,
        *,
        operation: str,
        code: int,
        payload: dict[str, Any] | None = None,
        cardkit_card_id: str = "",
    ) -> None:
        self.operation = str(operation or "").strip()
        self.code = int(code)
        self.payload = dict(payload or {})
        self.cardkit_card_id = str(cardkit_card_id or "").strip()
        super().__init__(f"[Feishu] {self.operation} failed: resp={self.payload}")


def _truncate_summary(text: str, max_length: int = 50) -> str:
    cleaned = str(text or "").replace("\n", " ").strip()
    if len(cleaned) <= max_length:
        return cleaned
    return cleaned[: max_length - 3] + "..."


def _strip_invalid_images(text: str) -> str:
    safe_text = str(text or "")
    if "![" not in safe_text:
        return safe_text
    parts: list[str] = []
    cursor = 0
    while True:
        start = safe_text.find("![", cursor)
        if start < 0:
            parts.append(safe_text[cursor:])
            break
        parts.append(safe_text[cursor:start])
        end = safe_text.find(")", start)
        mid = safe_text.find("](", start)
        if mid < 0 or end < 0:
            parts.append(safe_text[start:])
            break
        image_ref = safe_text[mid + 2 : end]
        if image_ref.startswith("img_"):
            parts.append(safe_text[start : end + 1])
        cursor = end + 1
    return "".join(parts)


def _optimize_markdown(text: str) -> str:
    safe_text = _strip_invalid_images(text)
    while "\n\n\n" in safe_text:
        safe_text = safe_text.replace("\n\n\n", "\n\n")
    return safe_text.strip()


def _build_streaming_card(content: str) -> dict[str, Any]:
    return {
        "schema": "2.0",
        "config": {
            "streaming_mode": True,
            "summary": {"content": "回答生成中..."},
            "streaming_config": {
                "print_frequency_ms": {"default": 50},
                "print_step": {"default": 2},
                "print_strategy": "fast",
            },
        },
        "body": {
            "elements": [
                {
                    "tag": "markdown",
                    "element_id": _STREAM_ELEMENT_ID,
                    "content": _optimize_markdown(content),
                }
            ]
        },
    }


class FeishuCardKitSender:
    async def stream_text(
        self,
        ctx: Any,
        card_id: str,
        *,
        content: str,
        sequence: int,
        emit_id: str,
    ) -> None:
        cardkit_card_id = await self._ensure_stream_message(
            ctx,
            card_id,
            initial_content=content,
            emit_id=emit_id,
        )
        await self._update_stream_content(
            cardkit_card_id,
            content=_optimize_markdown(content),
            sequence=sequence,
        )

    async def finalize_text(
        self,
        ctx: Any,
        card_id: str,
        *,
        content: str,
        sequence: int,
        error: bool = False,
        emit_id: str,
    ) -> None:
        cardkit_card_id = await self._ensure_stream_message(
            ctx,
            card_id,
            initial_content=content,
            emit_id=emit_id,
        )
        safe_content = _optimize_markdown(content)
        close_sequence = int(sequence)
        if safe_content:
            await self._update_stream_content(
                cardkit_card_id,
                content=safe_content,
                sequence=sequence,
            )
            close_sequence += 1
        summary = ("生成失败: " + _truncate_summary(content, max_length=40)) if error else _truncate_summary(content)
        await self._close_streaming_mode(
            cardkit_card_id,
            sequence=close_sequence,
            summary=summary,
        )
        await save_card_session_patch(card_id, {"cardkit_card_id": "", "cardkit_emit_id": ""})

    async def reopen_streaming_mode(
        self,
        cardkit_card_id: str,
        *,
        sequence: int,
        summary: str = "",
    ) -> None:
        settings = {
            "config": {
                "streaming_mode": True,
                "summary": {"content": str(summary or "")},
            }
        }
        payload = await self._request_json(
            "PATCH",
            f"{FEISHU_API_HOST}/cardkit/v1/cards/{cardkit_card_id}/settings",
            body={
                "settings": json.dumps(settings, ensure_ascii=False),
                "sequence": int(sequence),
                "uuid": f"reopen_{cardkit_card_id}_{int(sequence)}",
            },
            operation="reopen_streaming_mode",
        )
        code = int(payload.get("code", -1))
        if code != 0:
            raise FeishuCardKitError(
                operation="reopen_streaming_mode",
                code=code,
                payload=payload,
                cardkit_card_id=cardkit_card_id,
            )

    async def _ensure_stream_message(self, ctx: Any, card_id: str, *, initial_content: str, emit_id: str) -> str:
        extra_data = dict(getattr(ctx, "extra_data", {}) or {})
        cardkit_card_id = str(extra_data.get("cardkit_card_id") or "").strip()
        current_emit_id = str(extra_data.get("cardkit_emit_id") or "").strip()
        reuse_current_stream = bool(cardkit_card_id) and current_emit_id == str(emit_id or "").strip()
        if not reuse_current_stream:
            cardkit_card_id = await self._create_card_entity(initial_content="")
            await save_card_session_patch(
                card_id,
                {
                    "cardkit_card_id": cardkit_card_id,
                    "cardkit_emit_id": str(emit_id or "").strip(),
                },
            )

        platform_message_id = str(getattr(ctx, "platform_message_id", "") or "").strip() if reuse_current_stream else ""
        if not platform_message_id:
            platform_message_id = await self._send_card_message(ctx, cardkit_card_id)
            if platform_message_id:
                await save_card_delivery_handle(
                    card_id,
                    platform="feishu",
                    platform_message_id=platform_message_id,
                )
        return cardkit_card_id

    async def _create_card_entity(self, *, initial_content: str) -> str:
        data = {
            "type": _STREAM_CARD_TYPE,
            "data": json.dumps(_build_streaming_card(initial_content), ensure_ascii=False),
        }
        payload = await self._request_json(
            "POST",
            f"{FEISHU_API_HOST}/cardkit/v1/cards",
            body=data,
            operation="create_stream_card",
        )
        cardkit_card_id = str((payload.get("data") or {}).get("card_id") or "").strip()
        if not cardkit_card_id:
            raise RuntimeError(f"[Feishu] create_stream_card missing card_id: resp={payload}")
        logger.info("[Feishu] CardKit card created: card_id=%s", cardkit_card_id)
        return cardkit_card_id

    async def _send_card_message(self, ctx: Any, cardkit_card_id: str) -> str:
        raw_data = dict(getattr(ctx, "raw_data", {}) or {})
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
        content = json.dumps({"type": "card", "data": {"card_id": cardkit_card_id}}, ensure_ascii=False)
        if reply_to_message_id:
            payload = await self._request_json(
                "POST",
                f"{FEISHU_API_HOST}/im/v1/messages/{reply_to_message_id}/reply",
                body={"msg_type": "interactive", "content": content},
                operation="send_stream_card_reply",
            )
        else:
            if not chat_id:
                raise RuntimeError("[Feishu] missing chat_id for CardKit stream send")
            payload = await self._request_json(
                "POST",
                f"{FEISHU_API_HOST}/im/v1/messages?receive_id_type=chat_id",
                body={
                    "receive_id": chat_id,
                    "msg_type": "interactive",
                    "content": content,
                },
                operation="send_stream_card",
            )
        message_id = str((payload.get("data") or {}).get("message_id") or "").strip()
        if not message_id:
            raise RuntimeError(f"[Feishu] send_stream_card missing message_id: resp={payload}")
        logger.info("[Feishu] CardKit stream message sent: msg_id=%s card_id=%s", message_id, cardkit_card_id)
        return message_id

    async def _update_stream_content(self, cardkit_card_id: str, *, content: str, sequence: int) -> None:
        payload = await self._request_json(
            "PUT",
            f"{FEISHU_API_HOST}/cardkit/v1/cards/{cardkit_card_id}/elements/{_STREAM_ELEMENT_ID}/content",
            body={
                "content": str(content or ""),
                "sequence": int(sequence),
                "uuid": f"stream_{cardkit_card_id}_{int(sequence)}",
            },
            operation="stream_card_content",
        )
        code = int(payload.get("code", -1))
        if code != 0:
            raise FeishuCardKitError(
                operation="stream_card_content",
                code=code,
                payload=payload,
                cardkit_card_id=cardkit_card_id,
            )

    async def _close_streaming_mode(self, cardkit_card_id: str, *, sequence: int, summary: str) -> None:
        settings = {
            "config": {
                "streaming_mode": False,
                "summary": {"content": str(summary or "")},
            }
        }
        payload = await self._request_json(
            "PATCH",
            f"{FEISHU_API_HOST}/cardkit/v1/cards/{cardkit_card_id}/settings",
            body={
                "settings": json.dumps(settings, ensure_ascii=False),
                "sequence": int(sequence),
                "uuid": f"close_{cardkit_card_id}_{int(sequence)}",
            },
            operation="close_streaming_mode",
        )
        code = int(payload.get("code", -1))
        if code != 0:
            raise FeishuCardKitError(
                operation="close_streaming_mode",
                code=code,
                payload=payload,
                cardkit_card_id=cardkit_card_id,
            )

    async def _request_json(
        self,
        method: str,
        url: str,
        *,
        body: dict[str, Any],
        operation: str,
    ) -> dict[str, Any]:
        token = await token_manager.get_token()
        session = get_aiohttp_session(HttpSessionPurpose.EXTERNAL)
        response = await session.request(
            method.upper(),
            url,
            json=body,
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json; charset=utf-8",
            },
        )
        content_type = str(response.headers.get("Content-Type") or "").strip().lower()
        if "application/json" not in content_type:
            preview = (await response.text()).strip()[:300]
            raise RuntimeError(
                f"[Feishu] {operation} failed: status={response.status} "
                f"content_type={content_type or '<empty>'} url={url} body={preview}"
            )
        return dict(await response.json() or {})
