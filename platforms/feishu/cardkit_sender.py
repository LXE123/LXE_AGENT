from __future__ import annotations

import json
from typing import Any

from shared.db.client import save_response_route_delivery_handle, save_response_route_patch
from shared.infra.net import HttpSessionPurpose, get_aiohttp_session
from shared.logging import logger

from .auth import token_manager
from .config import FEISHU_API_HOST


_STREAM_ELEMENT_ID = "streaming_content"
_STREAM_CARD_TYPE = "card_json"
_REDACTED_THINKING_NOTICE = "部分思考已加密，无法展示"
_TOOL_PENDING_TITLE = "🛠️ 等待工具执行"


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


def _format_elapsed(ms: int) -> str:
    seconds = max(0, int(ms or 0)) / 1000
    if seconds < 60:
        return f"{seconds:.1f}s"
    return f"{int(seconds // 60)}m {int((seconds % 60) + 0.5)}s"


def _thinking_panel_title(thinking_elapsed_ms: int) -> str:
    safe_elapsed_ms = max(0, int(thinking_elapsed_ms or 0))
    if safe_elapsed_ms <= 0:
        return "💭 思考"
    return f"💭 思考了 {_format_elapsed(safe_elapsed_ms)}"


def _clean_tool_steps(tool_steps: Any) -> list[dict[str, Any]]:
    if not isinstance(tool_steps, list):
        return []
    steps: list[dict[str, Any]] = []
    for raw_step in tool_steps:
        if not isinstance(raw_step, dict):
            continue
        status = str(raw_step.get("status") or "running").strip()
        if status not in {"running", "success", "error"}:
            status = "running"
        steps.append(
            {
                "id": str(raw_step.get("id") or "").strip(),
                "name": str(raw_step.get("name") or "tool").strip() or "tool",
                "title": str(raw_step.get("title") or "Tool").strip() or "Tool",
                "detail": str(raw_step.get("detail") or "").strip(),
                "status": status,
                "duration_ms": max(0, int(raw_step.get("duration_ms") or 0)),
            }
        )
    return steps


def _escape_lark_md(text: str) -> str:
    return str(text or "").replace("\\", "\\\\").replace("*", "\\*").replace("`", "\\`").strip()


def _tool_status_label(status: str) -> tuple[str, str]:
    if status == "running":
        return "Running", "turquoise"
    if status == "error":
        return "Failed", "red"
    return "Succeeded", "green"


def _tool_step_title(step: dict[str, Any]) -> str:
    title = _escape_lark_md(str(step.get("title") or "Tool").strip() or "Tool")
    duration_ms = max(0, int(step.get("duration_ms") or 0))
    if duration_ms > 0:
        title = f"{title} ({_format_elapsed(duration_ms)})"
    label, color = _tool_status_label(str(step.get("status") or "running").strip())
    return f"**{title}** · <font color='{color}'>{label}</font>"


def _build_tool_step_elements(step: dict[str, Any]) -> list[dict[str, Any]]:
    elements: list[dict[str, Any]] = [
        {
            "tag": "div",
            "icon": {"tag": "standard_icon", "token": "setting_outlined", "color": "grey"},
            "text": {
                "tag": "lark_md",
                "content": _tool_step_title(step),
                "text_size": "notation",
            },
        }
    ]
    detail = str(step.get("detail") or "").strip()
    if detail:
        elements.append(
            {
                "tag": "div",
                "margin": "0px 0px 0px 24px",
                "text": {
                    "tag": "plain_text",
                    "content": detail,
                    "text_color": "grey",
                    "text_size": "notation",
                },
            }
        )
    return elements


def _tool_panel_title(*, mode: str, steps: list[dict[str, Any]], elapsed_ms: int) -> str:
    step_count = len(steps)
    elapsed = _format_elapsed(elapsed_ms) if int(elapsed_ms or 0) > 0 else ""
    if mode == "pending":
        return _TOOL_PENDING_TITLE
    if mode == "final":
        base = f"执行耗时 {elapsed}" if elapsed else "工具执行"
        return f"🛠️ {base} · 查看 {step_count} 个步骤"
    parts = [f"工具执行 · {step_count} 步"]
    if elapsed:
        parts.append(f"({elapsed})")
    return f"🛠️ {' · '.join(parts)}"


def _build_tool_panel(
    *,
    tool_pending: bool = False,
    tool_steps: list[dict[str, Any]] | None = None,
    tool_elapsed_ms: int = 0,
    final: bool = False,
) -> dict[str, Any] | None:
    steps = _clean_tool_steps(tool_steps)
    if not steps and not tool_pending:
        return None
    mode = "final" if final and steps else "active" if steps else "pending"
    title = _tool_panel_title(mode=mode, steps=steps, elapsed_ms=max(0, int(tool_elapsed_ms or 0)))
    elements = [element for step in steps for element in _build_tool_step_elements(step)]
    return {
        "tag": "collapsible_panel",
        "expanded": bool(mode == "active"),
        "header": {
            "title": {
                "tag": "plain_text",
                "content": title,
                "text_color": "grey",
                "text_size": "notation",
            },
            "vertical_align": "center",
            "icon": {
                "tag": "standard_icon",
                "token": "down-small-ccm_outlined",
                "color": "grey",
                "size": "16px 16px",
            },
            "icon_position": "right",
            "icon_expanded_angle": -180,
        },
        "border": {"color": "grey", "corner_radius": "5px"},
        "vertical_spacing": "4px",
        "padding": "8px 8px 8px 8px",
        "elements": elements,
    }


def _build_streaming_card(
    content: str,
    *,
    tool_pending: bool = False,
    tool_steps: list[dict[str, Any]] | None = None,
    tool_elapsed_ms: int = 0,
) -> dict[str, Any]:
    elements: list[dict[str, Any]] = []
    tool_panel = _build_tool_panel(
        tool_pending=tool_pending,
        tool_steps=tool_steps,
        tool_elapsed_ms=tool_elapsed_ms,
        final=False,
    )
    if tool_panel is not None:
        elements.append(tool_panel)
    elements.append(
        {
            "tag": "markdown",
            "element_id": _STREAM_ELEMENT_ID,
            "content": _optimize_markdown(content),
        }
    )
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
        "body": {"elements": elements},
    }


def _thinking_panel_content(*, thinking: str, redacted_thinking_count: int) -> str:
    parts: list[str] = []
    safe_thinking = str(thinking or "").strip()
    if safe_thinking:
        parts.append(safe_thinking)
    if int(redacted_thinking_count or 0) > 0:
        parts.append(_REDACTED_THINKING_NOTICE)
    return "\n\n".join(parts).strip()


def _build_thinking_panel(
    *,
    thinking: str,
    redacted_thinking_count: int,
    thinking_elapsed_ms: int = 0,
) -> dict[str, Any] | None:
    panel_content = _thinking_panel_content(
        thinking=thinking,
        redacted_thinking_count=redacted_thinking_count,
    )
    if not panel_content:
        return None
    return {
        "tag": "collapsible_panel",
        "expanded": False,
        "header": {
            "title": {
                "tag": "markdown",
                "content": _thinking_panel_title(thinking_elapsed_ms),
            },
            "vertical_align": "center",
            "icon": {
                "tag": "standard_icon",
                "token": "down-small-ccm_outlined",
                "size": "16px 16px",
            },
            "icon_position": "follow_text",
            "icon_expanded_angle": -180,
        },
        "border": {"color": "grey", "corner_radius": "5px"},
        "vertical_spacing": "8px",
        "padding": "8px 8px 8px 8px",
        "elements": [
            {
                "tag": "markdown",
                "content": _optimize_markdown(panel_content),
                "text_size": "notation",
            }
        ],
    }


def _build_final_card(
    *,
    content: str,
    thinking: str,
    redacted_thinking_count: int,
    thinking_elapsed_ms: int = 0,
    tool_steps: list[dict[str, Any]] | None = None,
    tool_elapsed_ms: int = 0,
    error: bool = False,
) -> dict[str, Any]:
    safe_content = _optimize_markdown(content)
    thinking_panel = _build_thinking_panel(
        thinking=thinking,
        redacted_thinking_count=redacted_thinking_count,
        thinking_elapsed_ms=thinking_elapsed_ms,
    )
    elements: list[dict[str, Any]] = []
    if thinking_panel is not None:
        elements.append(thinking_panel)
    tool_panel = _build_tool_panel(
        tool_steps=tool_steps,
        tool_elapsed_ms=tool_elapsed_ms,
        final=True,
    )
    if tool_panel is not None:
        elements.append(tool_panel)
    if safe_content:
        elements.append(
            {
                "tag": "markdown",
                "content": safe_content,
                "element_id": "content",
            }
        )
    if not elements:
        elements.append({"tag": "markdown", "content": " ", "element_id": "content"})

    summary_source = safe_content or _thinking_panel_content(
        thinking=thinking,
        redacted_thinking_count=redacted_thinking_count,
    )
    summary = ("生成失败: " + _truncate_summary(summary_source, max_length=40)) if error else _truncate_summary(summary_source)
    return {
        "schema": "2.0",
        "config": {
            "wide_screen_mode": True,
            "summary": {"content": summary},
        },
        "body": {"elements": elements},
    }


class FeishuCardKitSender:
    async def stream_text(
        self,
        ctx: Any,
        response_route_id: str,
        *,
        content: str,
        tool_pending: bool = False,
        tool_steps: list[dict[str, Any]] | None = None,
        tool_elapsed_ms: int = 0,
        replace_card: bool = False,
        sequence: int,
        emit_id: str,
    ) -> None:
        cardkit_card_id = await self._ensure_stream_message(
            ctx,
            response_route_id,
            initial_content=content,
            tool_pending=tool_pending,
            tool_steps=tool_steps,
            tool_elapsed_ms=tool_elapsed_ms,
            emit_id=emit_id,
        )
        if replace_card:
            await self._update_card(
                cardkit_card_id,
                card=_build_streaming_card(
                    content,
                    tool_pending=tool_pending,
                    tool_steps=tool_steps,
                    tool_elapsed_ms=tool_elapsed_ms,
                ),
                sequence=sequence,
            )
            return
        await self._update_stream_content(
            cardkit_card_id,
            content=_optimize_markdown(content),
            sequence=sequence,
        )

    async def finalize_text(
        self,
        ctx: Any,
        response_route_id: str,
        *,
        content: str,
        thinking: str = "",
        redacted_thinking_count: int = 0,
        thinking_elapsed_ms: int = 0,
        tool_steps: list[dict[str, Any]] | None = None,
        tool_elapsed_ms: int = 0,
        sequence: int,
        error: bool = False,
        emit_id: str,
    ) -> None:
        cardkit_card_id = await self._ensure_stream_message(
            ctx,
            response_route_id,
            initial_content=content,
            tool_steps=tool_steps,
            tool_elapsed_ms=tool_elapsed_ms,
            emit_id=emit_id,
        )
        safe_redacted_count = max(0, int(redacted_thinking_count or 0))
        final_card = _build_final_card(
            content=content,
            thinking=thinking,
            redacted_thinking_count=safe_redacted_count,
            thinking_elapsed_ms=max(0, int(thinking_elapsed_ms or 0)),
            tool_steps=tool_steps,
            tool_elapsed_ms=max(0, int(tool_elapsed_ms or 0)),
            error=error,
        )
        close_sequence = int(sequence)
        final_config = dict(final_card.get("config") or {})
        summary = str(dict(final_config.get("summary") or {}).get("content") or "").strip()
        await self._close_streaming_mode(
            cardkit_card_id,
            sequence=close_sequence,
            summary=summary,
        )
        await self._update_card(
            cardkit_card_id,
            card=final_card,
            sequence=close_sequence + 1,
        )
        await save_response_route_patch(response_route_id, {"cardkit_card_id": "", "cardkit_emit_id": ""})

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

    async def _ensure_stream_message(
        self,
        ctx: Any,
        response_route_id: str,
        *,
        initial_content: str,
        tool_pending: bool = False,
        tool_steps: list[dict[str, Any]] | None = None,
        tool_elapsed_ms: int = 0,
        emit_id: str,
    ) -> str:
        extra_data = dict(getattr(ctx, "extra_data", {}) or {})
        cardkit_card_id = str(extra_data.get("cardkit_card_id") or "").strip()
        current_emit_id = str(extra_data.get("cardkit_emit_id") or "").strip()
        reuse_current_stream = bool(cardkit_card_id) and current_emit_id == str(emit_id or "").strip()
        if not reuse_current_stream:
            cardkit_card_id = await self._create_card_entity(
                initial_content=initial_content,
                tool_pending=tool_pending,
                tool_steps=tool_steps,
                tool_elapsed_ms=tool_elapsed_ms,
            )
            await save_response_route_patch(
                response_route_id,
                {
                    "cardkit_card_id": cardkit_card_id,
                    "cardkit_emit_id": str(emit_id or "").strip(),
                },
            )

        platform_message_id = str(getattr(ctx, "platform_message_id", "") or "").strip() if reuse_current_stream else ""
        if not platform_message_id:
            platform_message_id = await self._send_card_message(ctx, cardkit_card_id)
            if platform_message_id:
                await save_response_route_delivery_handle(
                    response_route_id,
                    platform="feishu",
                    platform_message_id=platform_message_id,
                )
        return cardkit_card_id

    async def _create_card_entity(
        self,
        *,
        initial_content: str,
        tool_pending: bool = False,
        tool_steps: list[dict[str, Any]] | None = None,
        tool_elapsed_ms: int = 0,
    ) -> str:
        data = {
            "type": _STREAM_CARD_TYPE,
            "data": json.dumps(
                _build_streaming_card(
                    initial_content,
                    tool_pending=tool_pending,
                    tool_steps=tool_steps,
                    tool_elapsed_ms=tool_elapsed_ms,
                ),
                ensure_ascii=False,
            ),
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
        logger.info("[Feishu] CardKit card created: cardkit_card_id=%s", cardkit_card_id)
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
        logger.info("[Feishu] CardKit stream message sent: msg_id=%s cardkit_card_id=%s", message_id, cardkit_card_id)
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

    async def _update_card(self, cardkit_card_id: str, *, card: dict[str, Any], sequence: int) -> None:
        payload = await self._request_json(
            "PUT",
            f"{FEISHU_API_HOST}/cardkit/v1/cards/{cardkit_card_id}",
            body={
                "card": {
                    "type": _STREAM_CARD_TYPE,
                    "data": json.dumps(dict(card or {}), ensure_ascii=False),
                },
                "sequence": int(sequence),
                "uuid": f"update_{cardkit_card_id}_{int(sequence)}",
            },
            operation="update_card",
        )
        code = int(payload.get("code", -1))
        if code != 0:
            raise FeishuCardKitError(
                operation="update_card",
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
