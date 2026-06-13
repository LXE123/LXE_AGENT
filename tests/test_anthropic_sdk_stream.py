from __future__ import annotations

import asyncio
from typing import Any

import anthropic
import httpx
import pytest

from agent_runtime import llm_adapter
from shared.llm.errors import AnthropicStreamError, LLMProviderError
from shared.llm.events import LLMStreamEvent
from shared.llm.kimi_coding import client as kimi_coding_client
from shared.llm.model_capabilities import resolve_model_capabilities
from shared.llm.provider_catalog import ProviderDescriptor, descriptor_for_provider
from shared.llm.transports import anthropic_sdk_stream


class _FakeSdkObject:
    def __init__(self, **values: Any) -> None:
        self.__dict__.update(values)

    def model_dump(self, mode: str = "json") -> dict[str, Any]:
        _ = mode
        return {key: _dump_sdk_value(value) for key, value in self.__dict__.items()}


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
    def __init__(self, events: list[Any]) -> None:
        self._events = list(events)
        self.closed = False

    def __enter__(self) -> "_FakeStream":
        return self

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        return None

    def __iter__(self):
        return iter(self._events)

    def close(self) -> None:
        self.closed = True
        _RECORDER["stream_closed"] = int(_RECORDER.get("stream_closed") or 0) + 1


class _FakeMessages:
    def create(self, **kwargs: Any) -> _FakeStream:
        _RECORDER["create_kwargs"] = dict(kwargs)
        create_error = _RECORDER.get("create_error")
        if create_error is not None:
            raise create_error
        stream = _FakeStream(list(_RECORDER.get("events") or []))
        _RECORDER["stream"] = stream
        return stream


class _FakeAnthropic:
    def __init__(self, **kwargs: Any) -> None:
        _RECORDER["client_kwargs"] = dict(kwargs)
        self.default_headers = dict(kwargs.get("default_headers") or {})
        self.messages = _FakeMessages()

    def close(self) -> None:
        _RECORDER["client_closed"] = int(_RECORDER.get("client_closed") or 0) + 1


_RECORDER: dict[str, Any] = {}


def _descriptor() -> ProviderDescriptor:
    return ProviderDescriptor(
        name="kimi_coding",
        label="Kimi Coding",
        api_style="anthropic-messages",
        api_key="kimi-key",
        base_url="https://api.kimi.test/coding/",
        default_model="kimi-for-coding",
        thinking_request_style="anthropic-budget",
        thinking_levels=("off", "low"),
        thinking_level_labels={"low": "on"},
        thinking_default="off",
        default_headers={"User-Agent": "claude-code/0.1.0"},
    )


def _non_kimi_descriptor() -> ProviderDescriptor:
    return ProviderDescriptor(
        name="glm",
        label="GLM",
        api_style="anthropic-messages",
        api_key="glm-key",
        base_url="https://api.glm.test/anthropic",
        default_model="glm-5v-turbo",
        default_headers={"anthropic-version": "2023-06-01"},
    )


def _thinking_descriptor(style: str, *, max_tokens: int = 32768) -> ProviderDescriptor:
    return ProviderDescriptor(
        name=f"fake_{style}",
        label="Fake Anthropic",
        api_style="anthropic-messages",
        api_key="anthropic-key",
        base_url="https://api.anthropic.test",
        default_model="claude-test",
        max_tokens=max_tokens,
        thinking_request_style=style,
    )


def _set_thinking_config(
    monkeypatch,
    *,
    enabled: bool,
    effort: str = "medium",
    display: str = "omitted",
) -> None:
    monkeypatch.setattr(anthropic_sdk_stream.runtime_settings, "AGENT_LLM_THINKING_ENABLED", enabled)
    monkeypatch.setattr(anthropic_sdk_stream.runtime_settings, "AGENT_LLM_THINKING_EFFORT", effort)
    monkeypatch.setattr(anthropic_sdk_stream.runtime_settings, "AGENT_LLM_THINKING_DISPLAY", display)


def _install_fake_sdk(monkeypatch, events: list[Any]) -> None:
    _RECORDER.clear()
    _RECORDER["events"] = list(events)
    monkeypatch.setattr(anthropic_sdk_stream, "Anthropic", _FakeAnthropic)


def _api_status_error(status_code: int, body: Any) -> anthropic.APIStatusError:
    request = httpx.Request("POST", "https://api.kimi.test/coding/v1/messages")
    response = httpx.Response(status_code, request=request, json=body if isinstance(body, dict) else {"message": body})
    return anthropic.APIStatusError(
        f"Error code: {status_code} - {body}",
        response=response,
        body=body,
    )


def test_sdk_stream_request_shape_and_direct_events(monkeypatch) -> None:
    events = [
        _obj(
            type="message_start",
            message=_obj(
                id="msg_1",
                model="kimi-for-coding",
                role="assistant",
                usage=_obj(input_tokens=3, output_tokens=0),
            ),
        ),
        _obj(type="content_block_start", index=0, content_block=_obj(type="thinking", thinking="plan")),
        _obj(type="content_block_delta", index=0, delta=_obj(type="thinking_delta", thinking=" more")),
        _obj(type="content_block_delta", index=0, delta=_obj(type="signature_delta", signature="sig_1")),
        _obj(type="content_block_start", index=1, content_block=_obj(type="text", text="Hello")),
        _obj(type="content_block_delta", index=1, delta=_obj(type="text_delta", text=" world")),
        _obj(type="content_block_start", index=2, content_block=_obj(type="redacted_thinking", data="encrypted")),
        _obj(
            type="content_block_start",
            index=3,
            content_block=_obj(type="tool_use", id="tool_1", name="read", input={"path": "a.txt"}),
        ),
        _obj(type="content_block_delta", index=3, delta=_obj(type="input_json_delta", partial_json='{"limit":')),
        _obj(type="content_block_delta", index=3, delta=_obj(type="input_json_delta", partial_json=" 1}")),
        _obj(type="content_block_stop", index=3),
        _obj(type="message_delta", delta=_obj(stop_reason="tool_use"), usage=_obj(output_tokens=7)),
        _obj(type="message_stop"),
    ]
    _set_thinking_config(monkeypatch, enabled=False, effort="low")
    _install_fake_sdk(monkeypatch, events)

    parsed = list(
        anthropic_sdk_stream.stream_message_events(
            descriptor=_descriptor(),
            system_prompt=" system ",
            messages=[{"role": "user", "content": "hi"}],
            tool_schemas=[{"name": "read", "input_schema": {"type": "object"}}],
            tool_choice_mode="auto",
            max_tokens=123,
            temperature=0.9,
            timeout_s=11,
        )
    )

    assert _RECORDER["client_kwargs"] == {
        "api_key": "kimi-key",
        "base_url": "https://api.kimi.test/coding",
        "default_headers": {"User-Agent": "claude-code/0.1.0"},
    }
    create_kwargs = _RECORDER["create_kwargs"]
    assert create_kwargs["model"] == "kimi-for-coding"
    assert create_kwargs["max_tokens"] == 123
    assert create_kwargs["system"] == "system"
    assert create_kwargs["stream"] is True
    assert create_kwargs["tool_choice"] == {"type": "auto"}
    assert create_kwargs["timeout"] == 11.0
    assert create_kwargs["thinking"] == {"type": "disabled"}
    assert "output_config" not in create_kwargs
    assert all(isinstance(event, LLMStreamEvent) for event in parsed)
    assert [event.event_type for event in parsed] == [
        "message_start",
        "thinking_delta",
        "thinking_delta",
        "thinking_signature",
        "text_delta",
        "text_delta",
        "redacted_thinking",
        "tool_use",
        "message_delta",
        "message_stop",
    ]
    assert parsed[0].message_id == "msg_1"
    assert parsed[1].thinking_text == "plan"
    assert parsed[3].signature == "sig_1"
    assert parsed[4].text == "Hello"
    assert parsed[6].redacted_data == "encrypted"
    assert parsed[7].tool_call is not None
    assert parsed[7].tool_call.id == "tool_1"
    assert parsed[7].tool_call.name == "read"
    assert parsed[7].tool_call.arguments == {"path": "a.txt", "limit": 1}
    assert parsed[8].stop_reason == "tool_use"
    assert parsed[8].usage == {"output_tokens": 7}


def test_sdk_stream_registers_provider_cancel_handle(monkeypatch) -> None:
    events = [
        _obj(
            type="message_start",
            message=_obj(id="msg_1", model="kimi-for-coding", usage=_obj(input_tokens=1)),
        ),
        _obj(type="message_stop"),
    ]
    _install_fake_sdk(monkeypatch, events)
    registered: list[Any] = []

    def registrar(cancel_handle: Any) -> None:
        registered.append(cancel_handle)

    stream_iter = anthropic_sdk_stream.stream_message_events(
        descriptor=_descriptor(),
        system_prompt="system",
        messages=[{"role": "user", "content": "hi"}],
        tool_schemas=[],
        tool_choice_mode="none",
        max_tokens=None,
        temperature=0.1,
        timeout_s=11,
        provider_cancel_registrar=registrar,
    )

    first_event = next(stream_iter)
    assert first_event.event_type == "message_start"
    assert callable(registered[-1])

    registered[-1]()
    assert _RECORDER["client_closed"] >= 1
    assert _RECORDER["stream_closed"] >= 1

    remaining = list(stream_iter)
    assert [event.event_type for event in remaining] == ["message_stop"]
    assert registered[-1] is None


def test_sdk_stream_uses_default_max_tokens_when_unspecified(monkeypatch) -> None:
    _install_fake_sdk(monkeypatch, [_obj(type="message_stop")])

    list(
        anthropic_sdk_stream.stream_message_events(
            descriptor=_descriptor(),
            system_prompt="system",
            messages=[{"role": "user", "content": "hi"}],
            tool_schemas=None,
            tool_choice_mode="auto",
            max_tokens=None,
            temperature=0.1,
            timeout_s=30,
        )
    )

    assert _RECORDER["create_kwargs"]["max_tokens"] == 128_000


def test_sdk_stream_preserves_explicit_low_max_tokens(monkeypatch) -> None:
    _install_fake_sdk(monkeypatch, [_obj(type="message_stop")])

    list(
        anthropic_sdk_stream.stream_message_events(
            descriptor=_descriptor(),
            system_prompt="system",
            messages=[{"role": "user", "content": "hi"}],
            tool_schemas=None,
            tool_choice_mode="auto",
            max_tokens=123,
            temperature=0.1,
            timeout_s=30,
        )
    )

    assert _RECORDER["create_kwargs"]["max_tokens"] == 123


def test_sdk_stream_only_adds_user_agent_for_kimi(monkeypatch) -> None:
    _install_fake_sdk(monkeypatch, [_obj(type="message_stop")])

    list(
        anthropic_sdk_stream.stream_message_events(
            descriptor=_non_kimi_descriptor(),
            system_prompt="system",
            messages=[{"role": "user", "content": "hi"}],
            tool_schemas=None,
            tool_choice_mode="auto",
            max_tokens=None,
            temperature=0.1,
            timeout_s=30,
        )
    )

    assert _RECORDER["client_kwargs"] == {
        "api_key": "glm-key",
        "base_url": "https://api.glm.test/anthropic",
    }
    assert "default_headers" not in _RECORDER["client_kwargs"]


def test_sdk_stream_omits_tools_when_none(monkeypatch) -> None:
    _install_fake_sdk(monkeypatch, [_obj(type="message_stop")])

    list(
        anthropic_sdk_stream.stream_message_events(
            descriptor=_descriptor(),
            system_prompt="system",
            messages=[{"role": "user", "content": "hi"}],
            tool_schemas=None,
            tool_choice_mode="none",
            max_tokens=4096,
            temperature=0.1,
            timeout_s=30,
        )
    )

    create_kwargs = _RECORDER["create_kwargs"]
    assert create_kwargs["max_tokens"] == 4096
    assert "tools" not in create_kwargs
    assert create_kwargs["tool_choice"] == {"type": "none"}


@pytest.mark.parametrize(
    ("enabled", "effort"),
    [
        (False, "low"),
        (True, "off"),
    ],
)
def test_sdk_stream_kimi_thinking_disabled_sends_disabled_payload(
    monkeypatch,
    enabled: bool,
    effort: str,
) -> None:
    _set_thinking_config(monkeypatch, enabled=enabled, effort=effort, display="summarized")
    _install_fake_sdk(monkeypatch, [_obj(type="message_stop")])

    list(
        anthropic_sdk_stream.stream_message_events(
            descriptor=_descriptor(),
            system_prompt="system",
            messages=[{"role": "user", "content": "hi"}],
            tool_schemas=None,
            tool_choice_mode="auto",
            max_tokens=4096,
            temperature=0.1,
            timeout_s=30,
        )
    )

    create_kwargs = _RECORDER["create_kwargs"]
    assert create_kwargs["thinking"] == {"type": "disabled"}
    assert "output_config" not in create_kwargs


def test_sdk_stream_kimi_thinking_enabled_uses_low_budget(monkeypatch) -> None:
    _set_thinking_config(monkeypatch, enabled=True, effort="low")
    _install_fake_sdk(monkeypatch, [_obj(type="message_stop")])

    list(
        anthropic_sdk_stream.stream_message_events(
            descriptor=_descriptor(),
            system_prompt="system",
            messages=[{"role": "user", "content": "hi"}],
            tool_schemas=None,
            tool_choice_mode="auto",
            max_tokens=4096,
            temperature=0.1,
            timeout_s=30,
        )
    )

    create_kwargs = _RECORDER["create_kwargs"]
    assert create_kwargs["thinking"] == {
        "type": "enabled",
        "budget_tokens": 4000,
    }
    assert "output_config" not in create_kwargs


@pytest.mark.parametrize("effort", ["medium", "high", "xhigh"])
def test_sdk_stream_kimi_thinking_non_binary_efforts_fall_back_to_low(
    monkeypatch,
    effort: str,
) -> None:
    _set_thinking_config(monkeypatch, enabled=True, effort=effort)
    _install_fake_sdk(monkeypatch, [_obj(type="message_stop")])

    list(
        anthropic_sdk_stream.stream_message_events(
            descriptor=_descriptor(),
            system_prompt="system",
            messages=[{"role": "user", "content": "hi"}],
            tool_schemas=None,
            tool_choice_mode="auto",
            max_tokens=64000,
            temperature=0.1,
            timeout_s=30,
        )
    )

    create_kwargs = _RECORDER["create_kwargs"]
    assert create_kwargs["thinking"] == {
        "type": "enabled",
        "budget_tokens": 4000,
    }
    assert "output_config" not in create_kwargs


def test_sdk_stream_provider_managed_thinking_omits_request_payload(monkeypatch) -> None:
    _set_thinking_config(monkeypatch, enabled=True, effort="xhigh", display="summarized")
    _install_fake_sdk(monkeypatch, [_obj(type="message_stop")])

    list(
        anthropic_sdk_stream.stream_message_events(
            descriptor=_thinking_descriptor("provider-managed"),
            system_prompt="system",
            messages=[{"role": "user", "content": "hi"}],
            tool_schemas=None,
            tool_choice_mode="auto",
            max_tokens=4096,
            temperature=0.1,
            timeout_s=30,
        )
    )

    create_kwargs = _RECORDER["create_kwargs"]
    assert "thinking" not in create_kwargs
    assert "output_config" not in create_kwargs


def test_sdk_stream_adaptive_thinking_payload(monkeypatch) -> None:
    _set_thinking_config(monkeypatch, enabled=True, effort="high", display="summarized")
    _install_fake_sdk(monkeypatch, [_obj(type="message_stop")])

    list(
        anthropic_sdk_stream.stream_message_events(
            descriptor=_thinking_descriptor("anthropic-adaptive"),
            system_prompt="system",
            messages=[{"role": "user", "content": "hi"}],
            tool_schemas=None,
            tool_choice_mode="auto",
            max_tokens=4096,
            temperature=0.1,
            timeout_s=30,
        )
    )

    create_kwargs = _RECORDER["create_kwargs"]
    assert create_kwargs["thinking"] == {"type": "adaptive", "display": "summarized"}
    assert create_kwargs["output_config"] == {"effort": "high"}


@pytest.mark.parametrize(
    ("effort", "budget_tokens"),
    [
        ("low", 4000),
        ("medium", 8000),
        ("high", 16000),
        ("xhigh", 32000),
    ],
)
def test_sdk_stream_budget_thinking_maps_effort_to_tokens(
    monkeypatch,
    effort: str,
    budget_tokens: int,
) -> None:
    _set_thinking_config(monkeypatch, enabled=True, effort=effort)
    _install_fake_sdk(monkeypatch, [_obj(type="message_stop")])

    list(
        anthropic_sdk_stream.stream_message_events(
            descriptor=_thinking_descriptor("anthropic-budget", max_tokens=64000),
            system_prompt="system",
            messages=[{"role": "user", "content": "hi"}],
            tool_schemas=None,
            tool_choice_mode="auto",
            max_tokens=64000,
            temperature=0.1,
            timeout_s=30,
        )
    )

    assert _RECORDER["create_kwargs"]["thinking"] == {
        "type": "enabled",
        "budget_tokens": budget_tokens,
    }
    assert "output_config" not in _RECORDER["create_kwargs"]


def test_sdk_stream_budget_thinking_invalid_effort_falls_back_to_medium(monkeypatch) -> None:
    _set_thinking_config(monkeypatch, enabled=True, effort="wild")
    _install_fake_sdk(monkeypatch, [_obj(type="message_stop")])

    list(
        anthropic_sdk_stream.stream_message_events(
            descriptor=_thinking_descriptor("anthropic-budget"),
            system_prompt="system",
            messages=[{"role": "user", "content": "hi"}],
            tool_schemas=None,
            tool_choice_mode="auto",
            max_tokens=64000,
            temperature=0.1,
            timeout_s=30,
        )
    )

    assert _RECORDER["create_kwargs"]["thinking"] == {
        "type": "enabled",
        "budget_tokens": 8000,
    }


def test_sdk_stream_budget_thinking_clamps_or_skips_for_low_max_tokens(monkeypatch) -> None:
    _set_thinking_config(monkeypatch, enabled=True, effort="medium")
    _install_fake_sdk(monkeypatch, [_obj(type="message_stop")])

    list(
        anthropic_sdk_stream.stream_message_events(
            descriptor=_thinking_descriptor("anthropic-budget"),
            system_prompt="system",
            messages=[{"role": "user", "content": "hi"}],
            tool_schemas=None,
            tool_choice_mode="auto",
            max_tokens=5000,
            temperature=0.1,
            timeout_s=30,
        )
    )

    assert _RECORDER["create_kwargs"]["thinking"] == {
        "type": "enabled",
        "budget_tokens": 3976,
    }

    _install_fake_sdk(monkeypatch, [_obj(type="message_stop")])
    list(
        anthropic_sdk_stream.stream_message_events(
            descriptor=_thinking_descriptor("anthropic-budget"),
            system_prompt="system",
            messages=[{"role": "user", "content": "hi"}],
            tool_schemas=None,
            tool_choice_mode="auto",
            max_tokens=1024,
            temperature=0.1,
            timeout_s=30,
        )
    )

    assert "thinking" not in _RECORDER["create_kwargs"]


@pytest.mark.parametrize(
    ("status_code", "message", "category", "retryable"),
    [
        (401, "The API Key appears to be invalid or may have expired", "认证错误", False),
        (403, "Kimi For Coding is currently only available for Coding Agents", "权限错误", False),
        (404, "Not found the model kimi-for-coding or Permission denied", "资源未找到", False),
        (429, "We're receiving too many requests", "限流与配额", True),
        (500, "503 Service Unavailable", "服务端内部错误", True),
    ],
)
def test_sdk_status_errors_are_classified_for_kimi(
    monkeypatch,
    status_code: int,
    message: str,
    category: str,
    retryable: bool,
) -> None:
    _install_fake_sdk(monkeypatch, [])
    _RECORDER["create_error"] = _api_status_error(status_code, {"error": {"message": message}})

    with pytest.raises(LLMProviderError) as exc_info:
        list(
            anthropic_sdk_stream.stream_message_events(
                descriptor=_descriptor(),
                system_prompt="system",
                messages=[{"role": "user", "content": "hi"}],
                tool_schemas=None,
                tool_choice_mode="auto",
                max_tokens=None,
                temperature=0.1,
                timeout_s=30,
            )
        )

    error = exc_info.value
    assert error.provider == "kimi_coding"
    assert error.status_code == status_code
    assert error.category == category
    assert error.retryable is retryable
    assert error.user_message.startswith("Kimi Coding")


def test_sdk_status_errors_for_non_kimi_preserve_sdk_error(monkeypatch) -> None:
    _install_fake_sdk(monkeypatch, [])
    sdk_error = _api_status_error(401, {"error": {"message": "Invalid Authentication"}})
    _RECORDER["create_error"] = sdk_error

    with pytest.raises(anthropic.APIStatusError) as exc_info:
        list(
            anthropic_sdk_stream.stream_message_events(
                descriptor=_non_kimi_descriptor(),
                system_prompt="system",
                messages=[{"role": "user", "content": "hi"}],
                tool_schemas=None,
                tool_choice_mode="auto",
                max_tokens=None,
                temperature=0.1,
                timeout_s=30,
            )
        )

    assert exc_info.value is sdk_error


def test_sdk_stream_error_event_is_classified_for_kimi(monkeypatch) -> None:
    _install_fake_sdk(
        monkeypatch,
        [
            _obj(
                type="error",
                error={"message": "You've reached kimi monthly usage limit", "status_code": 429},
            )
        ],
    )

    with pytest.raises(LLMProviderError) as exc_info:
        list(
            anthropic_sdk_stream.stream_message_events(
                descriptor=_descriptor(),
                system_prompt="system",
                messages=[{"role": "user", "content": "hi"}],
                tool_schemas=None,
                tool_choice_mode="auto",
                max_tokens=None,
                temperature=0.1,
                timeout_s=30,
            )
        )

    assert exc_info.value.category == "限流与配额"
    assert exc_info.value.retryable is True


def test_sdk_stream_error_event_for_non_kimi_uses_stream_error(monkeypatch) -> None:
    _install_fake_sdk(monkeypatch, [_obj(type="error", error={"message": "stream failed"})])

    with pytest.raises(AnthropicStreamError) as exc_info:
        list(
            anthropic_sdk_stream.stream_message_events(
                descriptor=_non_kimi_descriptor(),
                system_prompt="system",
                messages=[{"role": "user", "content": "hi"}],
                tool_schemas=None,
                tool_choice_mode="auto",
                max_tokens=None,
                temperature=0.1,
                timeout_s=30,
            )
        )

    assert str(exc_info.value) == "stream failed"


async def _collect_adapter_events(**kwargs: Any) -> list[LLMStreamEvent]:
    return [event async for event in llm_adapter._stream_anthropic_events(**kwargs)]


def test_adapter_uses_sdk_events_even_with_legacy_transport_env(monkeypatch) -> None:
    legacy_env_name = "AGENT_" + "ANTHROPIC_TRANSPORT"
    monkeypatch.setenv(legacy_env_name, "manual")
    recorded: dict[str, Any] = {}

    def fake_sdk_stream_message_events(**kwargs: Any):
        recorded.update(kwargs)
        yield LLMStreamEvent(event_type="text_delta", index=0, text="sdk")

    monkeypatch.setattr(llm_adapter, "sdk_stream_message_events", fake_sdk_stream_message_events)

    events = asyncio.run(
        _collect_adapter_events(
            descriptor=_descriptor(),
            system_prompt="system",
            messages=[{"role": "user", "content": "hi"}],
            tool_schemas=None,
            tool_choice_mode="auto",
            max_tokens=None,
            temperature=0.1,
            timeout_s=30,
        )
    )

    assert events == [LLMStreamEvent(event_type="text_delta", index=0, text="sdk")]
    assert recorded["max_tokens"] is None


def test_kimi_coding_default_model_is_kimi_for_coding(monkeypatch) -> None:
    monkeypatch.delenv("KIMI_CODE_MODEL", raising=False)

    assert kimi_coding_client.default_model() == "kimi-for-coding"
    assert kimi_coding_client.normalize_model("kimi-code") == "kimi-for-coding"
    assert descriptor_for_provider("kimi_coding").default_model == "kimi-for-coding"
    assert descriptor_for_provider("kimi_coding", model_override="kimi-code").default_model == "kimi-for-coding"
    capabilities = resolve_model_capabilities("kimi_coding", "kimi-for-coding")
    assert capabilities.provider == "kimi_coding"
    assert capabilities.model == "kimi-for-coding"
    assert capabilities.max_tokens == 32768


def test_chat_with_tools_streaming_sdk_preserves_unspecified_max_tokens(monkeypatch) -> None:
    recorded: dict[str, Any] = {}

    def fake_sdk_stream_message_events(**kwargs: Any):
        recorded.update(kwargs)
        yield LLMStreamEvent(event_type="message_start", message_id="msg_1", model="kimi-for-coding")
        yield LLMStreamEvent(event_type="message_stop")

    def fail_effective_max_tokens(max_tokens: int | None = None) -> int:
        raise AssertionError("SDK anthropic route should preserve raw max_tokens")

    monkeypatch.setattr(llm_adapter, "sdk_stream_message_events", fake_sdk_stream_message_events)
    monkeypatch.setattr(llm_adapter, "effective_agent_planner_max_tokens", fail_effective_max_tokens)

    response = asyncio.run(
        llm_adapter.chat_with_tools_streaming(
            system_prompt="system",
            messages=[{"role": "user", "content": "hi"}],
            tool_schemas=None,
            tool_choice_mode="auto",
            max_tokens=None,
            temperature=0.1,
            timeout_s=30,
            descriptor=_descriptor(),
        )
    )

    assert recorded["max_tokens"] is None
    assert response.raw["id"] == "msg_1"


def test_chat_with_tools_anthropic_route_uses_sdk_streaming(monkeypatch) -> None:
    def fake_sdk_stream_message_events(**kwargs: Any):
        yield LLMStreamEvent(
            event_type="message_start",
            message_id="msg_2",
            model="kimi-for-coding",
            usage={"input_tokens": 2},
        )
        yield LLMStreamEvent(event_type="text_delta", index=0, text="hello")
        yield LLMStreamEvent(event_type="message_delta", stop_reason="end_turn", usage={"output_tokens": 1})
        yield LLMStreamEvent(event_type="message_stop")

    def fail_effective_max_tokens(max_tokens: int | None = None) -> int:
        raise AssertionError("chat_with_tools anthropic route should aggregate SDK streaming")

    monkeypatch.setattr(llm_adapter, "sdk_stream_message_events", fake_sdk_stream_message_events)
    monkeypatch.setattr(llm_adapter, "effective_agent_planner_max_tokens", fail_effective_max_tokens)

    response = asyncio.run(
        llm_adapter.chat_with_tools(
            system_prompt="system",
            messages=[{"role": "user", "content": "hi"}],
            tool_schemas=None,
            tool_choice_mode="auto",
            max_tokens=None,
            temperature=0.1,
            timeout_s=30,
            descriptor=_descriptor(),
        )
    )

    assert response.text == "hello"
    assert response.public_text == "hello"
    assert response.usage == {"input_tokens": 2, "output_tokens": 1}
    assert response.raw["id"] == "msg_2"
