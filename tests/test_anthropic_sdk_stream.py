from __future__ import annotations

import asyncio
from typing import Any

from agent_runtime import llm_adapter
from shared.config import config
from shared.llm.events import LLMStreamEvent, LLMToolCall
from shared.llm.kimi_coding import client as kimi_coding_client
from shared.llm.model_capabilities import resolve_model_capabilities
from shared.llm.provider_catalog import ProviderDescriptor
from shared.llm.provider_catalog import descriptor_for_provider
from shared.llm.transports import anthropic_sdk_stream, anthropic_stream
from shared.llm.transports.anthropic_stream import AnthropicStreamEvent


class _FakeSdkObject:
    def __init__(self, **values: Any) -> None:
        self._values = dict(values)
        for key, value in values.items():
            setattr(self, key, value)

    def model_dump(self, *, mode: str = "json") -> dict[str, Any]:
        assert mode == "json"
        return {key: _dump_sdk_value(value) for key, value in self._values.items()}


def _dump_sdk_value(value: Any) -> Any:
    if isinstance(value, _FakeSdkObject):
        return value.model_dump(mode="json")
    if isinstance(value, dict):
        return {key: _dump_sdk_value(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_dump_sdk_value(item) for item in value]
    return value


def _obj(**values: Any) -> _FakeSdkObject:
    return _FakeSdkObject(**values)


class _FakeStream:
    def __init__(self, events: list[_FakeSdkObject]) -> None:
        self._events = list(events)
        self.entered = False
        self.exited = False

    def __enter__(self):
        self.entered = True
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.exited = True

    def __iter__(self):
        return iter(self._events)


class _FakeMessages:
    def __init__(self, recorder: dict[str, Any]) -> None:
        self.recorder = recorder

    def create(self, **kwargs):
        self.recorder["create_kwargs"] = dict(kwargs)
        stream = _FakeStream(list(self.recorder["events"]))
        self.recorder["stream"] = stream
        return stream


class _FakeAnthropic:
    def __init__(self, **kwargs) -> None:
        _RECORDER["client_kwargs"] = dict(kwargs)
        self.default_headers = {
            "Content-Type": "application/json",
            "User-Agent": "Anthropic/Python test",
            "anthropic-version": "2023-06-01",
            "X-Api-Key": kwargs.get("api_key", ""),
        }
        self.messages = _FakeMessages(_RECORDER)


_RECORDER: dict[str, Any] = {}


def _descriptor() -> ProviderDescriptor:
    return ProviderDescriptor(
        name="kimi_coding",
        label="Kimi Coding",
        api_style="anthropic-messages",
        api_key="sk-test",
        base_url="https://api.kimi.com/coding/",
        default_model="kimi-for-coding",
        default_headers={"User-Agent": "claude-code/0.1.0"},
    )


def _non_kimi_descriptor() -> ProviderDescriptor:
    return ProviderDescriptor(
        name="glm",
        label="GLM",
        api_style="anthropic-messages",
        api_key="sk-test",
        base_url="https://open.bigmodel.cn/api/anthropic",
        default_model="glm-5v-turbo",
        default_headers={"User-Agent": "should-not-pass"},
    )


def _disable_old_sse_parser(monkeypatch) -> None:
    def _fail(*args, **kwargs):
        raise AssertionError("SDK transport should not use the manual SSE parser")

    monkeypatch.setattr(anthropic_stream, "iter_anthropic_sse_events", _fail)
    monkeypatch.setattr(anthropic_sdk_stream, "iter_anthropic_sse_events", _fail, raising=False)


def test_sdk_stream_request_shape_and_direct_events(monkeypatch) -> None:
    _RECORDER.clear()
    _RECORDER["events"] = [
        _obj(
            type="message_start",
            message=_obj(
                id="msg_test",
                type="message",
                role="assistant",
                model="kimi-for-coding",
                content=[],
                usage=_obj(input_tokens=10, output_tokens=0),
            ),
        ),
        _obj(type="content_block_start", index=0, content_block=_obj(type="thinking", thinking="", signature="")),
        _obj(type="content_block_delta", index=0, delta=_obj(type="thinking_delta", thinking="plan")),
        _obj(type="content_block_delta", index=0, delta=_obj(type="signature_delta", signature="sig-1")),
        _obj(type="content_block_stop", index=0),
        _obj(type="content_block_start", index=1, content_block=_obj(type="text", text="Hi")),
        _obj(type="content_block_delta", index=1, delta=_obj(type="text_delta", text=" there")),
        _obj(type="content_block_stop", index=1),
        _obj(type="content_block_start", index=2, content_block=_obj(type="redacted_thinking", data="sealed")),
        _obj(type="content_block_stop", index=2),
        _obj(
            type="content_block_start",
            index=3,
            content_block=_obj(type="tool_use", id="toolu_1", name="read", input={"path": "README.md"}),
        ),
        _obj(type="content_block_delta", index=3, delta=_obj(type="input_json_delta", partial_json='{"limit":')),
        _obj(type="content_block_delta", index=3, delta=_obj(type="input_json_delta", partial_json="2}")),
        _obj(type="content_block_delta", index=3, delta=_obj(type="citations_delta", citation={"url": "ignored"})),
        _obj(type="content_block_stop", index=3),
        _obj(type="message_delta", delta=_obj(stop_reason="tool_use"), usage=_obj(output_tokens=8)),
        _obj(type="message_stop"),
    ]
    _disable_old_sse_parser(monkeypatch)
    monkeypatch.setattr(anthropic_sdk_stream, "Anthropic", _FakeAnthropic)

    events = list(
        anthropic_sdk_stream.stream_message_events(
            descriptor=_descriptor(),
            system_prompt="system",
            messages=[{"role": "user", "content": "hello"}],
            tool_schemas=[{"name": "read", "description": "Read", "input_schema": {"type": "object"}}],
            tool_choice_mode="auto",
            max_tokens=123,
            temperature=0.7,
            timeout_s=9,
        )
    )

    assert _RECORDER["client_kwargs"] == {
        "api_key": "sk-test",
        "base_url": "https://api.kimi.com/coding",
        "default_headers": {"User-Agent": "claude-code/0.1.0"},
    }

    create_kwargs = _RECORDER["create_kwargs"]
    assert create_kwargs["model"] == "kimi-for-coding"
    assert create_kwargs["max_tokens"] == 123
    assert create_kwargs["system"] == "system"
    assert create_kwargs["messages"] == [{"role": "user", "content": "hello"}]
    assert create_kwargs["stream"] is True
    assert create_kwargs["tools"] == [{"name": "read", "description": "Read", "input_schema": {"type": "object"}}]
    assert create_kwargs["tool_choice"] == {"type": "auto"}
    assert create_kwargs["timeout"] == 9.0
    assert "thinking" not in create_kwargs
    assert "temperature" not in create_kwargs

    assert _RECORDER["stream"].entered is True
    assert _RECORDER["stream"].exited is True
    assert all(isinstance(event, LLMStreamEvent) for event in events)
    assert not any(isinstance(event, AnthropicStreamEvent) for event in events)
    assert [event.event_type for event in events] == [
        "message_start",
        "thinking_delta",
        "thinking_signature",
        "text_delta",
        "text_delta",
        "redacted_thinking",
        "tool_use",
        "message_delta",
        "message_stop",
    ]

    assert events[0].message_id == "msg_test"
    assert events[0].model == "kimi-for-coding"
    assert events[0].usage == {"input_tokens": 10, "output_tokens": 0}
    assert events[1].thinking_text == "plan"
    assert events[2].signature == "sig-1"
    assert events[3].index == 1
    assert events[3].text == "Hi"
    assert events[4].text == " there"
    assert events[5].redacted_data == "sealed"
    assert events[6].index == 3
    assert events[6].tool_call == LLMToolCall(id="toolu_1", name="read", arguments={"path": "README.md", "limit": 2})
    assert events[7].stop_reason == "tool_use"
    assert events[7].usage == {"output_tokens": 8}


def test_sdk_stream_uses_default_max_tokens_when_unspecified(monkeypatch) -> None:
    _RECORDER.clear()
    _RECORDER["events"] = [_obj(type="message_start", message=_obj(id="msg", model="kimi-for-coding", usage={}))]
    monkeypatch.setattr(anthropic_sdk_stream, "Anthropic", _FakeAnthropic)

    list(
        anthropic_sdk_stream.stream_message_events(
            descriptor=_descriptor(),
            system_prompt="system",
            messages=[],
            tool_schemas=None,
            tool_choice_mode="auto",
            max_tokens=None,
            temperature=0.1,
            timeout_s=3,
        )
    )

    assert _RECORDER["create_kwargs"]["max_tokens"] == 128_000


def test_sdk_stream_only_adds_user_agent_for_kimi(monkeypatch) -> None:
    _RECORDER.clear()
    _RECORDER["events"] = [_obj(type="message_start", message=_obj(id="msg", model="glm-5v-turbo", usage={}))]
    monkeypatch.setattr(anthropic_sdk_stream, "Anthropic", _FakeAnthropic)

    list(
        anthropic_sdk_stream.stream_message_events(
            descriptor=_non_kimi_descriptor(),
            system_prompt="system",
            messages=[],
            tool_schemas=None,
            tool_choice_mode="auto",
            max_tokens=None,
            temperature=0.1,
            timeout_s=3,
        )
    )

    assert _RECORDER["client_kwargs"] == {
        "api_key": "sk-test",
        "base_url": "https://open.bigmodel.cn/api/anthropic",
    }
    assert "default_headers" not in _RECORDER["client_kwargs"]


def test_sdk_stream_omits_tools_when_none(monkeypatch) -> None:
    _RECORDER.clear()
    _RECORDER["events"] = [_obj(type="message_start", message=_obj(id="msg", model="kimi-for-coding", usage={}))]
    monkeypatch.setattr(anthropic_sdk_stream, "Anthropic", _FakeAnthropic)

    list(
        anthropic_sdk_stream.stream_message_events(
            descriptor=_descriptor(),
            system_prompt=" system ",
            messages=[],
            tool_schemas=None,
            tool_choice_mode="none",
            max_tokens=4096,
            temperature=0.1,
            timeout_s=3,
        )
    )

    create_kwargs = _RECORDER["create_kwargs"]
    assert create_kwargs["max_tokens"] == 4096
    assert create_kwargs["system"] == "system"
    assert "tools" not in create_kwargs
    assert create_kwargs["tool_choice"] == {"type": "none"}


async def _collect_adapter_events(**kwargs: Any) -> list[LLMStreamEvent]:
    events: list[LLMStreamEvent] = []
    async for event in llm_adapter._stream_anthropic_events(**kwargs):
        events.append(event)
    return events


def test_adapter_sdk_branch_forwards_base_events_directly(monkeypatch) -> None:
    expected = LLMStreamEvent(event_type="text_delta", text="sdk")
    recorded: dict[str, Any] = {}

    def _fake_sdk_stream_message_events(**kwargs):
        recorded["kwargs"] = dict(kwargs)
        yield expected

    def _fail_manual_stream_message_events(**kwargs):
        raise AssertionError("manual transport should not run in sdk mode")

    monkeypatch.setenv("AGENT_ANTHROPIC_TRANSPORT", "sdk")
    monkeypatch.setattr(llm_adapter, "sdk_stream_message_events", _fake_sdk_stream_message_events)
    monkeypatch.setattr(llm_adapter, "stream_message_events", _fail_manual_stream_message_events)

    events = asyncio.run(
        _collect_adapter_events(
            descriptor=_descriptor(),
            system_prompt="system",
            messages=[],
            tool_schemas=None,
            tool_choice_mode="auto",
            max_tokens=None,
            temperature=0.1,
            timeout_s=3,
            wire_trace_context=None,
        )
    )

    assert events == [expected]
    assert recorded["kwargs"]["descriptor"] == _descriptor()
    assert recorded["kwargs"]["max_tokens"] is None


def test_kimi_coding_default_model_is_kimi_for_coding(monkeypatch) -> None:
    monkeypatch.delenv("KIMI_CODE_MODEL", raising=False)
    monkeypatch.delenv("AMAZON_STORE_AGENT_PLANNER_MODEL", raising=False)
    monkeypatch.setattr(config, "KIMI_CODE_MODEL", "kimi-code")
    monkeypatch.setattr(config, "AMAZON_STORE_AGENT_PLANNER_MODEL", "kimi-code")

    assert kimi_coding_client.default_model() == "kimi-for-coding"
    assert kimi_coding_client.normalize_model("kimi-code") == "kimi-for-coding"
    assert descriptor_for_provider("kimi_coding").default_model == "kimi-for-coding"
    assert descriptor_for_provider("kimi_coding", model_override="kimi-code").default_model == "kimi-for-coding"

    capabilities = resolve_model_capabilities("kimi_coding", "kimi-for-coding")
    assert capabilities.provider == "kimi_coding"
    assert capabilities.model == "kimi-for-coding"
    assert capabilities.supports_thinking is True


def test_adapter_manual_branch_keeps_anthropic_event_mapping(monkeypatch) -> None:
    manual_event = AnthropicStreamEvent(
        event_type="tool_use",
        index=4,
        tool_id="toolu_manual",
        tool_name="read",
        tool_input={"path": "README.md"},
    )

    def _fake_manual_stream_message_events(**kwargs):
        yield manual_event

    def _fail_sdk_stream_message_events(**kwargs):
        raise AssertionError("sdk transport should not run in manual mode")

    monkeypatch.setenv("AGENT_ANTHROPIC_TRANSPORT", "manual")
    monkeypatch.setattr(llm_adapter, "stream_message_events", _fake_manual_stream_message_events)
    monkeypatch.setattr(llm_adapter, "sdk_stream_message_events", _fail_sdk_stream_message_events)

    events = asyncio.run(
        _collect_adapter_events(
            descriptor=_descriptor(),
            system_prompt="system",
            messages=[],
            tool_schemas=None,
            tool_choice_mode="auto",
            max_tokens=256,
            temperature=0.1,
            timeout_s=3,
            wire_trace_context=None,
        )
    )

    assert events == [
        LLMStreamEvent(
            event_type="tool_use",
            index=4,
            tool_call=LLMToolCall(id="toolu_manual", name="read", arguments={"path": "README.md"}),
        )
    ]


def test_chat_with_tools_streaming_sdk_preserves_unspecified_max_tokens(monkeypatch) -> None:
    recorded: dict[str, Any] = {}

    def _fake_sdk_stream_message_events(**kwargs):
        recorded["kwargs"] = dict(kwargs)
        yield LLMStreamEvent(event_type="message_start", message_id="msg_sdk", model="kimi-for-coding")
        yield LLMStreamEvent(event_type="message_stop")

    def _fail_manual_stream_message_events(**kwargs):
        raise AssertionError("manual transport should not run in sdk mode")

    def _fail_effective_max_tokens(max_tokens):
        raise AssertionError("sdk mode should not resolve effective max_tokens before transport")

    monkeypatch.setenv("AGENT_ANTHROPIC_TRANSPORT", "sdk")
    monkeypatch.setattr(llm_adapter, "sdk_stream_message_events", _fake_sdk_stream_message_events)
    monkeypatch.setattr(llm_adapter, "stream_message_events", _fail_manual_stream_message_events)
    monkeypatch.setattr(llm_adapter, "effective_agent_planner_max_tokens", _fail_effective_max_tokens)

    response = asyncio.run(
        llm_adapter.chat_with_tools_streaming(
            system_prompt="system",
            messages=[{"role": "user", "content": "hello"}],
            tool_schemas=None,
            tool_choice_mode="auto",
            max_tokens=None,
            temperature=0.1,
            timeout_s=3,
            descriptor=_descriptor(),
        )
    )

    assert recorded["kwargs"]["max_tokens"] is None
    assert response.raw["id"] == "msg_sdk"


def test_chat_with_tools_streaming_manual_uses_effective_max_tokens(monkeypatch) -> None:
    recorded: dict[str, Any] = {}

    def _fake_manual_stream_message_events(**kwargs):
        recorded["kwargs"] = dict(kwargs)
        yield AnthropicStreamEvent(event_type="message_start", message_id="msg_manual", model="kimi-for-coding")
        yield AnthropicStreamEvent(event_type="message_stop")

    def _fail_sdk_stream_message_events(**kwargs):
        raise AssertionError("sdk transport should not run in manual mode")

    monkeypatch.setenv("AGENT_ANTHROPIC_TRANSPORT", "manual")
    monkeypatch.setattr(llm_adapter, "stream_message_events", _fake_manual_stream_message_events)
    monkeypatch.setattr(llm_adapter, "sdk_stream_message_events", _fail_sdk_stream_message_events)
    monkeypatch.setattr(llm_adapter, "effective_agent_planner_max_tokens", lambda requested: 777)

    response = asyncio.run(
        llm_adapter.chat_with_tools_streaming(
            system_prompt="system",
            messages=[{"role": "user", "content": "hello"}],
            tool_schemas=None,
            tool_choice_mode="auto",
            max_tokens=None,
            temperature=0.1,
            timeout_s=3,
            descriptor=_descriptor(),
        )
    )

    assert recorded["kwargs"]["max_tokens"] == 777
    assert response.raw["id"] == "msg_manual"
