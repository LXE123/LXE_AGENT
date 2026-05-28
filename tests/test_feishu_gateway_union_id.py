from __future__ import annotations

import asyncio
import logging
from types import SimpleNamespace

import platforms.feishu.gateway as feishu_gateway
from gateway.models import InboundEvent
from platforms.feishu.gateway import FeishuStreamAdapter
from platforms.feishu.message_parser import ParsedMessageContent


def _adapter_without_runtime() -> FeishuStreamAdapter:
    adapter = object.__new__(FeishuStreamAdapter)
    adapter.connector_key = "agent"
    adapter._bot_open_id = ""
    adapter._bot_open_id_source = "none"
    return adapter


def test_feishu_snapshot_reads_sender_union_id_and_header_app_id() -> None:
    snapshot = FeishuStreamAdapter._snapshot_message_event(
        SimpleNamespace(
            header=SimpleNamespace(app_id="cli_app"),
            event=SimpleNamespace(
                sender=SimpleNamespace(
                    sender_id=SimpleNamespace(
                        open_id="ou_sender_open_id",
                        user_id=None,
                        union_id="on_sender_union_id",
                    )
                ),
                message=SimpleNamespace(
                    message_type="text",
                    content='{"text":"hello"}',
                    chat_type="p2p",
                    chat_id="oc_chat",
                    message_id="om_msg",
                    mentions=[],
                ),
            ),
        )
    )

    assert snapshot is not None
    assert snapshot["app_id"] == "cli_app"
    assert snapshot["sender_open_id"] == "ou_sender_open_id"
    assert snapshot["sender_user_id"] == ""
    assert snapshot["sender_union_id"] == "on_sender_union_id"


def test_feishu_parse_keeps_open_id_as_session_user_and_sets_union_id(monkeypatch) -> None:
    async def fake_parse_message_payload_async(*_args, **_kwargs) -> ParsedMessageContent:
        return ParsedMessageContent(text="hello")

    monkeypatch.setattr(feishu_gateway, "parse_message_payload_async", fake_parse_message_payload_async)
    adapter = _adapter_without_runtime()

    event = asyncio.run(
        adapter._parse_message_event(
            {
                "app_id": "cli_app",
                "message_type": "text",
                "content": '{"text":"hello"}',
                "chat_type": "p2p",
                "chat_id": "oc_chat",
                "message_id": "om_msg",
                "sender_open_id": "ou_sender_open_id",
                "sender_user_id": "",
                "sender_union_id": "on_sender_union_id",
            }
        )
    )

    assert event is not None
    assert event.user_id == "ou_sender_open_id"
    assert event.union_id == "on_sender_union_id"
    assert event.raw_data["app_id"] == "cli_app"
    assert event.raw_data["open_id"] == "ou_sender_open_id"
    assert event.raw_data["sender_open_id"] == "ou_sender_open_id"
    assert event.raw_data["sender_user_id"] == ""
    assert event.raw_data["sender_union_id"] == "on_sender_union_id"
    assert event.raw_data["union_id"] == "on_sender_union_id"


def test_feishu_inbound_log_includes_union_id(caplog) -> None:
    adapter = _adapter_without_runtime()
    emitted: list[InboundEvent] = []
    adapter._inbound_sink = emitted.append
    event = InboundEvent(
        platform="feishu",
        connector_key="agent",
        event_type="agent_message",
        user_input="hello",
        user_id="ou_sender_open_id",
        union_id="on_sender_union_id",
        conversation_id="oc_chat",
        is_group=False,
        message_id="om_msg",
        sender_nick="sender",
    )

    caplog.set_level(logging.INFO, logger="bot_logger")
    adapter.emit(event)

    assert emitted == [event]
    assert "user_id=ou_sender_open_id" in caplog.text
    assert "union_id=on_sender_union_id" in caplog.text
