from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from typing import Any

from gateway.models import OutboundRequest
import platforms.feishu.cardkit_sender as cardkit_mod
from platforms.feishu.cardkit_sender import FeishuCardKitSender, _build_final_card, _build_streaming_card
from platforms.feishu.gateway import FeishuStreamAdapter, _StreamWriterState, _stream_display_content


def test_stream_display_content_prefers_answer_over_thinking() -> None:
    writer = _StreamWriterState(last_content="answer", last_thinking="plan", redacted_thinking_count=1)

    assert _stream_display_content(writer) == "answer"


def test_stream_display_content_shows_thinking_phase() -> None:
    writer = _StreamWriterState(last_thinking="plan")

    assert _stream_display_content(writer) == "💭 **思考中...**\n\nplan"


def test_stream_display_content_shows_redacted_placeholder() -> None:
    writer = _StreamWriterState(redacted_thinking_count=1)

    assert _stream_display_content(writer) == "💭 **思考中...**\n\n部分思考已加密，无法展示"


def test_final_card_contains_collapsed_thinking_panel_without_redacted_data() -> None:
    card = _build_final_card(
        content="answer",
        thinking="plan",
        redacted_thinking_count=1,
    )

    panel = card["body"]["elements"][0]
    assert panel["tag"] == "collapsible_panel"
    assert panel["expanded"] is False
    assert panel["header"]["title"]["content"] == "💭 思考"
    panel_text = panel["elements"][0]["content"]
    assert "plan" in panel_text
    assert "部分思考已加密，无法展示" in panel_text
    assert card["body"]["elements"][1]["content"] == "answer"
    assert "encrypted" not in json.dumps(card, ensure_ascii=False)


def test_final_card_thinking_panel_title_includes_elapsed_duration() -> None:
    card = _build_final_card(
        content="answer",
        thinking="plan",
        redacted_thinking_count=0,
        thinking_elapsed_ms=3200,
    )

    panel = card["body"]["elements"][0]
    assert panel["header"]["title"]["content"] == "💭 思考了 3.2s"


def test_final_card_thinking_panel_title_omits_zero_elapsed_duration() -> None:
    card = _build_final_card(
        content="answer",
        thinking="plan",
        redacted_thinking_count=0,
        thinking_elapsed_ms=0,
    )

    panel = card["body"]["elements"][0]
    assert panel["header"]["title"]["content"] == "💭 思考"


def test_streaming_card_shows_pending_tool_panel() -> None:
    card = _build_streaming_card("", tool_pending=True)

    panel = card["body"]["elements"][0]
    assert panel["tag"] == "collapsible_panel"
    assert panel["expanded"] is False
    assert panel["header"]["title"]["content"] == "🛠️ 等待工具执行"
    assert card["body"]["elements"][1]["element_id"] == "streaming_content"


def test_streaming_card_shows_active_tool_steps_with_elapsed_without_result() -> None:
    card = _build_streaming_card(
        "answer",
        tool_steps=[
            {
                "id": "toolu-1",
                "name": "exec",
                "title": "Run command",
                "detail": "uv run pytest",
                "status": "running",
                "duration_ms": 0,
                "result": "must not render",
            }
        ],
        tool_elapsed_ms=3200,
    )

    panel = card["body"]["elements"][0]
    assert panel["expanded"] is True
    assert panel["header"]["title"]["content"] == "🛠️ 工具执行 · 1 步 · (3.2s)"
    assert "Run command" in panel["elements"][0]["text"]["content"]
    assert "Running" in panel["elements"][0]["text"]["content"]
    assert panel["elements"][1]["text"]["content"] == "uv run pytest"
    assert "must not render" not in json.dumps(card, ensure_ascii=False)


def test_final_card_contains_collapsed_tool_panel_without_result_or_error_body() -> None:
    card = _build_final_card(
        content="answer",
        thinking="",
        redacted_thinking_count=0,
        tool_steps=[
            {
                "id": "toolu-1",
                "name": "exec",
                "title": "Run command",
                "detail": "uv run pytest",
                "status": "error",
                "duration_ms": 3200,
                "result": "secret result",
                "error": "traceback body",
            }
        ],
        tool_elapsed_ms=3200,
    )

    panel = card["body"]["elements"][0]
    assert panel["tag"] == "collapsible_panel"
    assert panel["expanded"] is False
    assert panel["header"]["title"]["content"] == "🛠️ 执行耗时 3.2s · 查看 1 个步骤"
    assert "Failed" in panel["elements"][0]["text"]["content"]
    payload = json.dumps(card, ensure_ascii=False)
    assert "secret result" not in payload
    assert "traceback body" not in payload
    assert card["body"]["elements"][1]["content"] == "answer"


def test_finalize_text_closes_stream_then_updates_final_card(monkeypatch) -> None:
    calls: list[dict[str, Any]] = []

    async def fake_ensure_stream_message(
        self,
        ctx,
        response_route_id,
        *,
        initial_content: str,
        tool_pending: bool = False,
        tool_steps: list[dict[str, Any]] | None = None,
        tool_elapsed_ms: int = 0,
        emit_id: str,
    ) -> str:
        _ = self, ctx, response_route_id, initial_content, tool_pending, tool_steps, tool_elapsed_ms, emit_id
        return "card_1"

    async def fake_request_json(self, method: str, url: str, *, body: dict[str, Any], operation: str) -> dict[str, Any]:
        _ = self
        calls.append(
            {
                "method": method,
                "url": url,
                "body": body,
                "operation": operation,
            }
        )
        return {"code": 0}

    async def fake_save_response_route_patch(response_route_id: str, patch: dict[str, Any]) -> None:
        calls.append({"operation": "save_patch", "response_route_id": response_route_id, "patch": patch})

    monkeypatch.setattr(FeishuCardKitSender, "_ensure_stream_message", fake_ensure_stream_message)
    monkeypatch.setattr(FeishuCardKitSender, "_request_json", fake_request_json)
    monkeypatch.setattr(cardkit_mod, "save_response_route_patch", fake_save_response_route_patch)

    sender = FeishuCardKitSender()
    asyncio.run(
        sender.finalize_text(
            SimpleNamespace(),
            "route-1",
            content="answer",
            thinking="plan",
            redacted_thinking_count=1,
            thinking_elapsed_ms=3200,
            sequence=7,
            emit_id="emit-1",
        )
    )

    assert calls[0]["operation"] == "close_streaming_mode"
    assert calls[0]["method"] == "PATCH"
    assert calls[0]["url"].endswith("/cardkit/v1/cards/card_1/settings")
    assert calls[0]["body"]["sequence"] == 7
    assert calls[1]["operation"] == "update_card"
    assert calls[1]["method"] == "PUT"
    assert calls[1]["url"].endswith("/cardkit/v1/cards/card_1")
    assert calls[1]["body"]["sequence"] == 8
    final_card = json.loads(calls[1]["body"]["card"]["data"])
    assert final_card["body"]["elements"][0]["tag"] == "collapsible_panel"
    assert final_card["body"]["elements"][0]["expanded"] is False
    assert final_card["body"]["elements"][0]["header"]["title"]["content"] == "💭 思考了 3.2s"
    assert final_card["body"]["elements"][1]["content"] == "answer"
    assert "encrypted" not in json.dumps(final_card, ensure_ascii=False)
    assert calls[2] == {
        "operation": "save_patch",
        "response_route_id": "route-1",
        "patch": {"cardkit_card_id": "", "cardkit_emit_id": ""},
    }


def test_feishu_stream_adapter_passes_thinking_elapsed_to_final_card_sender() -> None:
    calls: list[dict[str, Any]] = []

    class FakeCardKitSender:
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
            calls.append(
                {
                    "ctx": ctx,
                    "response_route_id": response_route_id,
                    "content": content,
                    "thinking": thinking,
                    "redacted_thinking_count": redacted_thinking_count,
                    "thinking_elapsed_ms": thinking_elapsed_ms,
                    "tool_steps": tool_steps,
                    "tool_elapsed_ms": tool_elapsed_ms,
                    "sequence": sequence,
                    "error": error,
                    "emit_id": emit_id,
                }
            )

    adapter = object.__new__(FeishuStreamAdapter)
    adapter._stream_state = {}
    adapter._stream_locks = {}
    adapter._cardkit_sender = FakeCardKitSender()

    request = OutboundRequest(
        action="stream_message",
        platform="feishu",
        payload={
            "stream_type": "final_answer",
            "state": "final",
            "seq": 1,
            "content": "answer",
            "thinking": "plan",
            "redacted_thinking_count": 1,
            "thinking_elapsed_ms": 3200,
        },
        session_id="session-1",
        response_route_id="route-1",
        event_id="emit-1",
    )

    route_ctx = SimpleNamespace()
    asyncio.run(adapter._handle_stream_message(request, route_ctx))

    assert calls == [
        {
            "ctx": route_ctx,
            "response_route_id": "route-1",
            "content": "answer",
            "thinking": "plan",
            "redacted_thinking_count": 1,
            "thinking_elapsed_ms": 3200,
            "tool_steps": [],
            "tool_elapsed_ms": 0,
            "sequence": 1,
            "error": False,
            "emit_id": "emit-1",
        }
    ]
    assert adapter._stream_state == {}


def test_feishu_stream_adapter_passes_tool_steps_to_final_card_sender() -> None:
    calls: list[dict[str, Any]] = []

    class FakeCardKitSender:
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
            calls.append(
                {
                    "tool_steps": tool_steps,
                    "tool_elapsed_ms": tool_elapsed_ms,
                    "sequence": sequence,
                    "error": error,
                }
            )

    adapter = object.__new__(FeishuStreamAdapter)
    adapter._stream_state = {}
    adapter._stream_locks = {}
    adapter._cardkit_sender = FakeCardKitSender()

    request = OutboundRequest(
        action="stream_message",
        platform="feishu",
        payload={
            "stream_type": "final_answer",
            "state": "final",
            "seq": 1,
            "content": "answer",
            "tool_elapsed_ms": 3200,
            "tool_steps": [
                {
                    "id": "toolu-1",
                    "name": "exec",
                    "title": "Run command",
                    "detail": "uv run pytest",
                    "status": "success",
                    "duration_ms": 3200,
                    "result": "must not pass",
                }
            ],
        },
        session_id="session-1",
        response_route_id="route-1",
        event_id="emit-1",
    )

    asyncio.run(adapter._handle_stream_message(request, SimpleNamespace()))

    assert calls == [
        {
            "tool_steps": [
                {
                    "id": "toolu-1",
                    "name": "exec",
                    "title": "Run command",
                    "detail": "uv run pytest",
                    "status": "success",
                    "duration_ms": 3200,
                }
            ],
            "tool_elapsed_ms": 3200,
            "sequence": 1,
            "error": False,
        }
    ]
