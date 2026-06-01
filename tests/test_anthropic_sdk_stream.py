from __future__ import annotations

from shared.llm.provider_catalog import ProviderDescriptor
from shared.llm.transports import anthropic_sdk_stream


class _FakeSdkEvent:
    def __init__(self, payload: dict) -> None:
        self._payload = dict(payload)

    def model_dump(self, *, mode: str = "json") -> dict:
        assert mode == "json"
        return dict(self._payload)


class _FakeStream:
    def __init__(self, events: list[_FakeSdkEvent]) -> None:
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
    def __init__(self, recorder: dict) -> None:
        self.recorder = recorder

    def create(self, **kwargs):
        self.recorder["create_kwargs"] = dict(kwargs)
        return _FakeStream(
            [
                _FakeSdkEvent(
                    {
                        "type": "message_start",
                        "message": {
                            "id": "msg_test",
                            "type": "message",
                            "role": "assistant",
                            "model": "kimi-code",
                            "content": [],
                            "usage": {"input_tokens": 10, "output_tokens": 0},
                        },
                    }
                ),
                _FakeSdkEvent(
                    {
                        "type": "content_block_start",
                        "index": 0,
                        "content_block": {"type": "text", "text": ""},
                    }
                ),
                _FakeSdkEvent(
                    {
                        "type": "content_block_delta",
                        "index": 0,
                        "delta": {"type": "text_delta", "text": "OK"},
                    }
                ),
                _FakeSdkEvent({"type": "content_block_stop", "index": 0}),
                _FakeSdkEvent(
                    {
                        "type": "message_delta",
                        "delta": {"stop_reason": "end_turn"},
                        "usage": {"output_tokens": 1},
                    }
                ),
                _FakeSdkEvent({"type": "message_stop"}),
            ]
        )


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


_RECORDER: dict = {}


def test_sdk_stream_request_shape_and_events(monkeypatch) -> None:
    _RECORDER.clear()
    monkeypatch.setattr(anthropic_sdk_stream, "Anthropic", _FakeAnthropic)
    descriptor = ProviderDescriptor(
        name="kimi_coding",
        label="Kimi Coding",
        api_style="anthropic-messages",
        api_key="sk-test",
        base_url="https://api.kimi.com/coding/",
        default_model="kimi-code",
        default_headers={"User-Agent": "claude-code/0.1.0"},
    )

    events = list(
        anthropic_sdk_stream.stream_message_events(
            descriptor=descriptor,
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
    }
    assert "default_headers" not in _RECORDER["client_kwargs"]

    create_kwargs = _RECORDER["create_kwargs"]
    assert create_kwargs["model"] == "kimi-code"
    assert create_kwargs["max_tokens"] == 256
    assert create_kwargs["system"] == "system"
    assert create_kwargs["messages"] == [{"role": "user", "content": "hello"}]
    assert create_kwargs["stream"] is True
    assert create_kwargs["tools"] == [{"name": "read", "description": "Read", "input_schema": {"type": "object"}}]
    assert create_kwargs["tool_choice"] == {"type": "auto"}
    assert create_kwargs["timeout"] == 9.0
    assert "thinking" not in create_kwargs
    assert "temperature" not in create_kwargs

    assert [event.event_type for event in events] == [
        "message_start",
        "text_delta",
        "message_delta",
        "message_stop",
    ]
    assert events[0].message_id == "msg_test"
    assert events[1].text == "OK"
    assert events[2].stop_reason == "end_turn"
