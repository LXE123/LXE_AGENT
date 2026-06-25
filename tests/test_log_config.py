from __future__ import annotations

from agent_runtime.stream_logging import load_stream_logging_config
from agent_runtime.tools import feishu_im_tools
from shared.llm.transports.wire_trace import load_wire_trace_config
from shared.log_config import local_logs_enabled


def test_local_logs_enabled_defaults_to_false(monkeypatch) -> None:
    monkeypatch.delenv("LOCAL_LOGS_ENABLED", raising=False)

    assert local_logs_enabled() is False


def test_local_logs_enabled_false_values(monkeypatch) -> None:
    for value in ("0", "false", "no", "off", ""):
        monkeypatch.setenv("LOCAL_LOGS_ENABLED", value)

        assert local_logs_enabled() is False


def test_local_logs_enabled_true_values(monkeypatch) -> None:
    for value in ("1", "true", "yes", "on"):
        monkeypatch.setenv("LOCAL_LOGS_ENABLED", value)

        assert local_logs_enabled() is True


def test_stream_trace_disabled_when_local_logs_disabled(monkeypatch) -> None:
    monkeypatch.setenv("LOCAL_LOGS_ENABLED", "0")
    monkeypatch.setenv("AGENT_STREAM_TRACE_ENABLED", "1")

    assert load_stream_logging_config().trace_enabled is False


def test_stream_trace_disabled_when_local_logs_unset(monkeypatch) -> None:
    monkeypatch.delenv("LOCAL_LOGS_ENABLED", raising=False)
    monkeypatch.setenv("AGENT_STREAM_TRACE_ENABLED", "1")

    assert load_stream_logging_config().trace_enabled is False


def test_stream_trace_respects_feature_switch_when_local_logs_enabled(monkeypatch) -> None:
    monkeypatch.setenv("LOCAL_LOGS_ENABLED", "1")
    monkeypatch.setenv("AGENT_STREAM_TRACE_ENABLED", "0")

    assert load_stream_logging_config().trace_enabled is False


def test_stream_trace_enabled_when_local_logs_and_feature_switch_enabled(monkeypatch) -> None:
    monkeypatch.setenv("LOCAL_LOGS_ENABLED", "1")
    monkeypatch.setenv("AGENT_STREAM_TRACE_ENABLED", "1")

    assert load_stream_logging_config().trace_enabled is True


def test_wire_trace_disabled_when_local_logs_disabled(monkeypatch) -> None:
    monkeypatch.setenv("LOCAL_LOGS_ENABLED", "0")
    monkeypatch.setenv("AGENT_SSE_WIRE_TRACE_ENABLED", "1")

    assert load_wire_trace_config().enabled is False


def test_wire_trace_disabled_when_local_logs_unset(monkeypatch) -> None:
    monkeypatch.delenv("LOCAL_LOGS_ENABLED", raising=False)
    monkeypatch.setenv("AGENT_SSE_WIRE_TRACE_ENABLED", "1")

    assert load_wire_trace_config().enabled is False


def test_wire_trace_respects_feature_switch_when_local_logs_enabled(monkeypatch) -> None:
    monkeypatch.setenv("LOCAL_LOGS_ENABLED", "1")
    monkeypatch.setenv("AGENT_SSE_WIRE_TRACE_ENABLED", "0")

    assert load_wire_trace_config().enabled is False


def test_wire_trace_enabled_when_local_logs_and_feature_switch_enabled(monkeypatch) -> None:
    monkeypatch.setenv("LOCAL_LOGS_ENABLED", "1")
    monkeypatch.setenv("AGENT_SSE_WIRE_TRACE_ENABLED", "1")

    assert load_wire_trace_config().enabled is True


def test_feishu_im_raw_message_dump_respects_global_local_logs_switch(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("LOCAL_LOGS_ENABLED", "0")
    debug_root = tmp_path / "feishu_msg"
    monkeypatch.setattr(feishu_im_tools, "_feishu_msg_debug_root", lambda: debug_root)

    dump_path = feishu_im_tools._dump_raw_messages(
        tool_name="feishu_im_bot_get_messages",
        chat_id="oc_test",
        query={"page_size": 1},
        items=[{"message_id": "om_test", "body": {"content": "{}"}}],
    )

    assert dump_path == ""
    assert not debug_root.exists()
