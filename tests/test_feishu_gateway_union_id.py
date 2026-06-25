from __future__ import annotations

import asyncio
import json
import logging
from types import SimpleNamespace

import platforms.feishu.gateway as feishu_gateway
from gateway.models import InboundEvent
from platforms.feishu.gateway import FeishuStreamAdapter
from platforms.feishu.message_parser import InboundResource, ParsedMessageContent


def _adapter_without_runtime() -> FeishuStreamAdapter:
    adapter = object.__new__(FeishuStreamAdapter)
    adapter._thread = None
    adapter._loop = None
    adapter._client = None
    adapter._bot_open_id = ""
    adapter._bot_name = ""
    adapter._bot_open_id_source = "none"
    adapter._last_probe_ok = False
    adapter._last_probe_at = 0.0
    adapter._host_loop = None
    adapter._seen_message_ids = {}
    return adapter


class _RunningLoop:
    def is_running(self) -> bool:
        return True


class _DummyFuture:
    def add_done_callback(self, _callback) -> None:
        return None


def _install_handler_probe(monkeypatch, adapter: FeishuStreamAdapter, now_ref: dict[str, float]) -> list[object]:
    submitted: list[object] = []
    adapter._host_loop = _RunningLoop()
    monkeypatch.setattr(feishu_gateway, "_dump_feishu_raw_event", lambda **_kwargs: None)
    monkeypatch.setattr(feishu_gateway, "_now_ms", lambda: int(now_ref["ms"]))
    monkeypatch.setattr(feishu_gateway, "_monotonic_seconds", lambda: float(now_ref["monotonic"]))

    def fake_run_coroutine_threadsafe(coro, _loop):
        submitted.append(coro)
        coro.close()
        return _DummyFuture()

    monkeypatch.setattr(feishu_gateway.asyncio, "run_coroutine_threadsafe", fake_run_coroutine_threadsafe)
    return submitted


def test_feishu_adapter_ignores_manual_bot_open_id_env(monkeypatch) -> None:
    monkeypatch.setenv("FEISHU_BOT_OPEN_ID", "ou_manual_bot")
    monkeypatch.setattr(feishu_gateway, "validate_feishu_runtime_config", lambda: None)

    adapter = FeishuStreamAdapter()

    assert adapter._bot_open_id == ""
    assert adapter._bot_open_id_source == ""


def test_feishu_adapter_probe_populates_bot_identity(monkeypatch) -> None:
    async def fake_probe():
        return SimpleNamespace(
            ok=True,
            app_id="cli_app",
            bot_open_id="ou_probe_bot",
            bot_name="FBA业务助手",
            error="",
        )

    monkeypatch.setattr(feishu_gateway, "probe_feishu_bot_identity", fake_probe)
    adapter = _adapter_without_runtime()

    asyncio.run(adapter._refresh_bot_identity())

    assert adapter._bot_open_id == "ou_probe_bot"
    assert adapter._bot_name == "FBA业务助手"
    assert adapter._bot_open_id_source == "probe"
    assert adapter._last_probe_ok is True
    assert adapter.health()["bot_open_id_available"] is True


def _fake_lark_message_event(
    *,
    root_id: str | None = None,
    parent_id: str | None = None,
    message_id: str = "om_msg",
    create_time: str | None = None,
    update_time: str | None = None,
) -> SimpleNamespace:
    return SimpleNamespace(
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
                thread_id=None,
                root_id=root_id,
                parent_id=parent_id,
                create_time=create_time,
                update_time=update_time,
                message_id=message_id,
                mentions=[],
            ),
        ),
    )


def test_feishu_snapshot_reads_sender_union_id_and_header_app_id() -> None:
    snapshot = FeishuStreamAdapter._snapshot_message_event(_fake_lark_message_event())

    assert snapshot is not None
    assert snapshot["app_id"] == "cli_app"
    assert snapshot["sender_open_id"] == "ou_sender_open_id"
    assert snapshot["sender_user_id"] == ""
    assert snapshot["sender_union_id"] == "on_sender_union_id"
    assert snapshot["root_id"] == ""
    assert snapshot["parent_id"] == ""
    assert snapshot["create_time"] == ""
    assert snapshot["update_time"] == ""


def test_feishu_snapshot_reads_reply_relationship() -> None:
    snapshot = FeishuStreamAdapter._snapshot_message_event(
        _fake_lark_message_event(root_id="om_root", parent_id="om_parent")
    )

    assert snapshot is not None
    assert snapshot["root_id"] == "om_root"
    assert snapshot["parent_id"] == "om_parent"


def test_feishu_snapshot_reads_message_timestamps() -> None:
    snapshot = FeishuStreamAdapter._snapshot_message_event(
        _fake_lark_message_event(create_time="1700000000123", update_time="1700000000456")
    )

    assert snapshot is not None
    assert snapshot["create_time"] == "1700000000123"
    assert snapshot["update_time"] == "1700000000456"


def test_feishu_handler_dedupes_duplicate_message_id(monkeypatch) -> None:
    adapter = _adapter_without_runtime()
    now_ref = {"ms": 1_000_000.0, "monotonic": 1000.0}
    submitted = _install_handler_probe(monkeypatch, adapter, now_ref)
    handler = adapter._build_message_handler(object)

    handler(_fake_lark_message_event(message_id="om_dup"))
    handler(_fake_lark_message_event(message_id="om_dup"))

    assert len(submitted) == 1


def test_feishu_handler_drops_message_over_max_age(monkeypatch, caplog) -> None:
    adapter = _adapter_without_runtime()
    now_ref = {"ms": 1_000_000.0, "monotonic": 1000.0}
    submitted = _install_handler_probe(monkeypatch, adapter, now_ref)
    old_create_time = int(now_ref["ms"] - (feishu_gateway._FEISHU_INBOUND_MAX_AGE_SECONDS + 1) * 1000)

    caplog.set_level(logging.INFO, logger="bot_logger")
    adapter._build_message_handler(object)(
        _fake_lark_message_event(message_id="om_old_age", create_time=str(old_create_time))
    )

    assert submitted == []
    assert "reason=max_age" in caplog.text


def test_feishu_handler_accepts_missing_or_invalid_create_time(monkeypatch) -> None:
    adapter = _adapter_without_runtime()
    now_ref = {"ms": 1_000_000.0, "monotonic": 1000.0}
    submitted = _install_handler_probe(monkeypatch, adapter, now_ref)
    handler = adapter._build_message_handler(object)

    handler(_fake_lark_message_event(message_id="om_missing_time"))
    handler(_fake_lark_message_event(message_id="om_invalid_time", create_time="not-a-timestamp"))

    assert len(submitted) == 2


def test_feishu_handler_allows_same_message_id_after_dedup_ttl(monkeypatch) -> None:
    adapter = _adapter_without_runtime()
    now_ref = {"ms": 1_000_000.0, "monotonic": 1000.0}
    submitted = _install_handler_probe(monkeypatch, adapter, now_ref)
    handler = adapter._build_message_handler(object)

    handler(_fake_lark_message_event(message_id="om_ttl"))
    handler(_fake_lark_message_event(message_id="om_ttl"))
    now_ref["monotonic"] += feishu_gateway._FEISHU_INBOUND_DEDUP_TTL_SECONDS + 1
    handler(_fake_lark_message_event(message_id="om_ttl"))

    assert len(submitted) == 2


def test_feishu_raw_event_dump_disabled_by_feature_switch(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("LOCAL_LOGS_ENABLED", "1")
    monkeypatch.setattr(feishu_gateway, "FEISHU_RAW_EVENT_DUMP_ENABLED", False)
    monkeypatch.setattr(feishu_gateway, "FEISHU_RAW_EVENT_DUMP_DIR", str(tmp_path))
    adapter = _adapter_without_runtime()

    adapter._build_message_handler(object)(_fake_lark_message_event())

    assert list(tmp_path.glob("*.jsonl")) == []


def test_feishu_raw_event_dump_disabled_by_global_local_logs_switch(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("LOCAL_LOGS_ENABLED", "0")
    monkeypatch.setattr(feishu_gateway, "FEISHU_RAW_EVENT_DUMP_ENABLED", True)
    monkeypatch.setattr(feishu_gateway, "FEISHU_RAW_EVENT_DUMP_DIR", str(tmp_path))
    adapter = _adapter_without_runtime()

    adapter._build_message_handler(object)(_fake_lark_message_event())

    assert list(tmp_path.glob("*.jsonl")) == []


def test_feishu_raw_event_dump_writes_raw_event_and_snapshot(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("LOCAL_LOGS_ENABLED", "1")
    monkeypatch.setattr(feishu_gateway, "FEISHU_RAW_EVENT_DUMP_ENABLED", True)
    monkeypatch.setattr(feishu_gateway, "FEISHU_RAW_EVENT_DUMP_DIR", str(tmp_path))
    adapter = _adapter_without_runtime()

    adapter._build_message_handler(object)(_fake_lark_message_event())

    dump_files = list(tmp_path.glob("*.jsonl"))
    assert len(dump_files) == 1
    record = json.loads(dump_files[0].read_text(encoding="utf-8").strip())
    assert record["adapter"] == "feishu"
    assert record["event_class"] == "types.SimpleNamespace"
    assert record["raw_event"]["header"]["app_id"] == "cli_app"
    assert record["raw_event"]["event"]["message"]["content"] == '{"text":"hello"}'
    assert record["snapshot"]["message_id"] == "om_msg"
    assert record["snapshot"]["sender_union_id"] == "on_sender_union_id"


def test_feishu_raw_event_dump_failure_does_not_block_handler(monkeypatch, caplog) -> None:
    def fail_write(_record):
        raise RuntimeError("dump boom")

    monkeypatch.setenv("LOCAL_LOGS_ENABLED", "1")
    monkeypatch.setattr(feishu_gateway, "FEISHU_RAW_EVENT_DUMP_ENABLED", True)
    monkeypatch.setattr(feishu_gateway, "_write_feishu_raw_event_dump", fail_write)
    adapter = _adapter_without_runtime()

    caplog.set_level(logging.WARNING, logger="bot_logger")
    adapter._build_message_handler(object)(_fake_lark_message_event())

    assert "dump failed" in caplog.text


def test_feishu_parse_keeps_open_id_as_session_user_and_sets_union_id(monkeypatch) -> None:
    async def fake_parse_message_payload_async(*_args, **_kwargs) -> ParsedMessageContent:
        return ParsedMessageContent(text="hello")

    monkeypatch.setattr(feishu_gateway, "parse_message_payload_async", fake_parse_message_payload_async)
    adapter = _adapter_without_runtime()
    adapter._bot_open_id = "ou_probe_bot"
    adapter._bot_name = "FBA业务助手"
    adapter._bot_open_id_source = "probe"

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
    assert event.source["platform"] == "feishu"
    assert event.source["chat_id"] == "oc_chat"
    assert event.source["chat_type"] == "p2p"
    assert event.source["user_id"] == "ou_sender_open_id"
    assert event.source["user_id_alt"] == "on_sender_union_id"
    assert event.source["extra"] == {
        "bot_app_id": "cli_app",
        "bot_id": "ou_probe_bot",
        "bot_name": "FBA业务助手",
        "bot_id_source": "probe",
        "message_type": "text",
    }


def test_feishu_parse_without_parent_does_not_fetch_quoted_message(monkeypatch) -> None:
    called = False

    async def fake_parse_message_payload_async(*_args, **_kwargs) -> ParsedMessageContent:
        return ParsedMessageContent(text="hello")

    async def fail_get_message_items(_message_id: str):
        nonlocal called
        called = True
        raise RuntimeError("should not fetch parent")

    monkeypatch.setattr(feishu_gateway, "parse_message_payload_async", fake_parse_message_payload_async)
    monkeypatch.setattr(feishu_gateway.api_client, "get_message_items", fail_get_message_items)
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
                "sender_union_id": "on_sender_union_id",
            }
        )
    )

    assert event is not None
    assert event.user_input == "hello"
    assert called is False
    assert "quoted_message" not in event.raw_data


def test_feishu_parse_parent_injects_quoted_message(monkeypatch) -> None:
    calls: list[str] = []

    async def fake_parse_message_payload_async(*_args, **_kwargs) -> ParsedMessageContent:
        return ParsedMessageContent(text="hello")

    async def fake_get_message_items(message_id: str):
        calls.append(message_id)
        return [{"message_id": message_id}]

    async def fake_format_message_list(items, *, chat_id: str):
        assert items == [{"message_id": "om_parent"}]
        assert chat_id == "oc_chat"
        return [
            {
                "message_id": "om_parent",
                "sender": {"name": "Alice", "open_id": "ou_alice"},
                "content": "quoted text",
            }
        ]

    monkeypatch.setattr(feishu_gateway, "parse_message_payload_async", fake_parse_message_payload_async)
    monkeypatch.setattr(feishu_gateway.api_client, "get_message_items", fake_get_message_items)
    monkeypatch.setattr(feishu_gateway, "format_message_list", fake_format_message_list)
    adapter = _adapter_without_runtime()

    event = asyncio.run(
        adapter._parse_message_event(
            {
                "app_id": "cli_app",
                "message_type": "text",
                "content": '{"text":"hello"}',
                "chat_type": "p2p",
                "chat_id": "oc_chat",
                "root_id": "om_root",
                "parent_id": "om_parent",
                "message_id": "om_msg",
                "sender_open_id": "ou_sender_open_id",
                "sender_union_id": "on_sender_union_id",
            }
        )
    )

    assert event is not None
    assert calls == ["om_parent"]
    assert event.user_input == "[Replying to message_id=om_parent]\nAlice: quoted text\n\nhello"
    assert event.source["root_id"] == "om_root"
    assert event.source["parent_id"] == "om_parent"
    assert event.raw_data["root_id"] == "om_root"
    assert event.raw_data["parent_id"] == "om_parent"
    assert event.raw_data["quoted_message"]["available"] is True
    assert event.raw_data["quoted_message"]["content"] == "quoted text"


def test_feishu_parse_parent_injects_quote_before_multimodal_blocks(monkeypatch) -> None:
    async def fake_parse_message_payload_async(*_args, **_kwargs) -> ParsedMessageContent:
        return ParsedMessageContent(
            text="current text",
            resources=[InboundResource(type="image", file_key="img_current")],
        )

    async def fake_resolve_inbound_message(*_args, **_kwargs):
        return SimpleNamespace(
            user_input="current text",
            user_content_blocks=[
                {"type": "text", "text": "current text"},
                {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "abc"}},
            ],
            resource_metadata=[{"type": "image", "file_key": "img_current"}],
        )

    async def fake_get_message_items(message_id: str):
        return [{"message_id": message_id}]

    async def fake_format_message_list(_items, *, chat_id: str):
        return [
            {
                "message_id": "om_parent",
                "sender": {"name": "Alice"},
                "content": "![image](img_parent)",
            }
        ]

    monkeypatch.setattr(feishu_gateway, "parse_message_payload_async", fake_parse_message_payload_async)
    monkeypatch.setattr(feishu_gateway, "resolve_inbound_message", fake_resolve_inbound_message)
    monkeypatch.setattr(feishu_gateway.api_client, "get_message_items", fake_get_message_items)
    monkeypatch.setattr(feishu_gateway, "format_message_list", fake_format_message_list)
    adapter = _adapter_without_runtime()

    event = asyncio.run(
        adapter._parse_message_event(
            {
                "app_id": "cli_app",
                "message_type": "image",
                "content": '{"image_key":"img_current"}',
                "chat_type": "p2p",
                "chat_id": "oc_chat",
                "parent_id": "om_parent",
                "message_id": "om_msg",
                "sender_open_id": "ou_sender_open_id",
                "sender_union_id": "on_sender_union_id",
            }
        )
    )

    assert event is not None
    assert event.user_content_blocks[0]["type"] == "text"
    assert event.user_content_blocks[0]["text"] == (
        "[Replying to message_id=om_parent]\nAlice: ![image](img_parent)\n\ncurrent text"
    )
    assert event.user_content_blocks[1]["type"] == "image"
    assert event.raw_data["resources"] == [{"type": "image", "file_key": "img_current"}]
    assert event.raw_data["quoted_message"]["content"] == "![image](img_parent)"


def test_feishu_parse_parent_fetch_failure_keeps_current_message(monkeypatch, caplog) -> None:
    async def fake_parse_message_payload_async(*_args, **_kwargs) -> ParsedMessageContent:
        return ParsedMessageContent(text="hello")

    async def fail_get_message_items(_message_id: str):
        raise RuntimeError("parent unavailable")

    monkeypatch.setattr(feishu_gateway, "parse_message_payload_async", fake_parse_message_payload_async)
    monkeypatch.setattr(feishu_gateway.api_client, "get_message_items", fail_get_message_items)
    adapter = _adapter_without_runtime()

    caplog.set_level(logging.WARNING, logger="bot_logger")
    event = asyncio.run(
        adapter._parse_message_event(
            {
                "app_id": "cli_app",
                "message_type": "text",
                "content": '{"text":"hello"}',
                "chat_type": "p2p",
                "chat_id": "oc_chat",
                "parent_id": "om_parent",
                "message_id": "om_msg",
                "sender_open_id": "ou_sender_open_id",
                "sender_union_id": "on_sender_union_id",
            }
        )
    )

    assert event is not None
    assert event.user_input == "[Replying to message_id=om_parent; quoted message unavailable]\n\nhello"
    assert event.raw_data["quoted_message"]["available"] is False
    assert "parent unavailable" in event.raw_data["quoted_message"]["error"]
    assert "failed to load quoted message" in caplog.text


def test_feishu_inbound_log_includes_union_id(caplog) -> None:
    adapter = _adapter_without_runtime()
    emitted: list[InboundEvent] = []
    adapter._inbound_sink = emitted.append
    event = InboundEvent(
        platform="feishu",
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
