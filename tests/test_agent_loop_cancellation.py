from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

from agent_runtime import loop as loop_mod
from agent_runtime.context_pipeline import is_context_overflow_error, load_context_messages, validate_tool_call_closure
from agent_runtime.llm_adapter import LLMResponse
from agent_runtime.loop import AgentLoop
from agent_runtime.tool_registry import UnifiedToolRegistry
from agent_runtime.types import ToolDefinition, TurnInput, text_tool_result
from shared.llm.errors import LLMProviderError
from shared.llm.events import LLMStreamEvent, LLMToolCall


def _session() -> SimpleNamespace:
    return SimpleNamespace(
        session_id="session-1",
        owner_user_id="user-1",
        state_data={},
        source={"platform": "feishu"},
        conversation_type="1",
    )


def _turn_input() -> TurnInput:
    return TurnInput(
        user_input="请处理",
        session_id="session-1",
        user_id="user-1",
        available_skills=[],
    )


def _agent(
    *,
    cancellation_check=None,
    on_final_text_delta=None,
    on_final_stream_event=None,
    on_tool_start=None,
    on_tool_finish=None,
) -> AgentLoop:
    agent = AgentLoop(
        session=_session(),
        state_data={},
        on_final_text_delta=on_final_text_delta,
        on_final_stream_event=on_final_stream_event,
        on_tool_start=on_tool_start,
        on_tool_finish=on_tool_finish,
        cancellation_check=cancellation_check,
    )
    agent.tool_registry = UnifiedToolRegistry()
    return agent


def test_cancelled_stream_without_complete_response_persists_user_only(monkeypatch) -> None:
    async def fake_chat_with_tools_streaming(**_kwargs: Any) -> LLMResponse:
        raise loop_mod._TurnCancelledError()

    monkeypatch.setattr(loop_mod, "chat_with_tools_streaming", fake_chat_with_tools_streaming)

    outcome = asyncio.run(_agent().run(_turn_input()))
    messages = load_context_messages(outcome.state_data_patch)

    assert outcome.status == "cancelled"
    assert messages == [{"role": "user", "content": "请处理"}]


def test_cancel_after_complete_text_response_persists_assistant_text(monkeypatch) -> None:
    cancel_after_response = {"value": False}

    async def cancellation_check() -> bool:
        return bool(cancel_after_response["value"])

    async def fake_chat_with_tools_streaming(**_kwargs: Any) -> LLMResponse:
        cancel_after_response["value"] = True
        return LLMResponse(
            text="完成",
            public_text="完成",
            assistant_content=[{"type": "text", "text": "完成"}],
        )

    monkeypatch.setattr(loop_mod, "chat_with_tools_streaming", fake_chat_with_tools_streaming)

    outcome = asyncio.run(_agent(cancellation_check=cancellation_check).run(_turn_input()))
    messages = load_context_messages(outcome.state_data_patch)

    assert outcome.status == "cancelled"
    assert messages == [
        {"role": "user", "content": "请处理"},
        {"role": "assistant", "content": [{"type": "text", "text": "完成"}]},
    ]


def test_legacy_final_text_delta_receives_answer_text_only(monkeypatch) -> None:
    async def fake_chat_with_tools_streaming(**kwargs: Any) -> LLMResponse:
        on_stream_event = kwargs["on_stream_event"]
        await on_stream_event(LLMStreamEvent(event_type="thinking_delta", thinking_text="plan", text="plan"))
        await on_stream_event(LLMStreamEvent(event_type="redacted_thinking", redacted_data="encrypted"))
        await on_stream_event(LLMStreamEvent(event_type="text_delta", text="answer"))
        return LLMResponse(
            text="answer",
            public_text="answer",
            assistant_content=[
                {"type": "thinking", "thinking": "plan", "signature": ""},
                {"type": "redacted_thinking", "data": "encrypted"},
                {"type": "text", "text": "answer"},
            ],
        )

    text_deltas: list[str] = []

    async def on_final_text_delta(delta: str) -> None:
        text_deltas.append(delta)

    monkeypatch.setattr(loop_mod, "chat_with_tools_streaming", fake_chat_with_tools_streaming)

    outcome = asyncio.run(_agent(on_final_text_delta=on_final_text_delta).run(_turn_input()))

    assert outcome.status == "done"
    assert outcome.reply == "answer"
    assert text_deltas == ["answer"]


def test_structured_final_stream_event_receives_thinking_and_answer(monkeypatch) -> None:
    async def fake_chat_with_tools_streaming(**kwargs: Any) -> LLMResponse:
        on_stream_event = kwargs["on_stream_event"]
        await on_stream_event(LLMStreamEvent(event_type="thinking_delta", thinking_text="plan", text="plan"))
        await on_stream_event(LLMStreamEvent(event_type="redacted_thinking", redacted_data="encrypted"))
        await on_stream_event(LLMStreamEvent(event_type="text_delta", text="answer"))
        return LLMResponse(
            text="answer",
            public_text="answer",
            assistant_content=[
                {"type": "thinking", "thinking": "plan", "signature": ""},
                {"type": "redacted_thinking", "data": "encrypted"},
                {"type": "text", "text": "answer"},
            ],
        )

    stream_events: list[LLMStreamEvent] = []

    async def on_final_stream_event(event: LLMStreamEvent) -> None:
        stream_events.append(event)

    monkeypatch.setattr(loop_mod, "chat_with_tools_streaming", fake_chat_with_tools_streaming)

    outcome = asyncio.run(_agent(on_final_stream_event=on_final_stream_event).run(_turn_input()))

    assert outcome.status == "done"
    assert outcome.reply == "answer"
    assert [event.event_type for event in stream_events] == [
        "thinking_delta",
        "redacted_thinking",
        "text_delta",
    ]


def test_cancel_after_complete_tool_use_persists_synthetic_tool_result(monkeypatch) -> None:
    cancel_after_response = {"value": False}
    tool_call = LLMToolCall(id="toolu-1", name="read", arguments={"path": "a.txt"})

    async def cancellation_check() -> bool:
        return bool(cancel_after_response["value"])

    async def fake_chat_with_tools_streaming(**_kwargs: Any) -> LLMResponse:
        cancel_after_response["value"] = True
        return LLMResponse(
            text="",
            assistant_content=[
                {
                    "type": "tool_call",
                    "id": tool_call.id,
                    "name": tool_call.name,
                    "arguments": dict(tool_call.arguments),
                }
            ],
            tool_calls=[tool_call],
        )

    monkeypatch.setattr(loop_mod, "chat_with_tools_streaming", fake_chat_with_tools_streaming)

    outcome = asyncio.run(_agent(cancellation_check=cancellation_check).run(_turn_input()))
    messages = load_context_messages(outcome.state_data_patch)

    assert outcome.status == "cancelled"
    assert messages[1] == {
        "role": "assistant",
        "content": [
            {
                "type": "tool_call",
                "id": "toolu-1",
                "name": "read",
                "arguments": {"path": "a.txt"},
            }
        ],
    }
    assert messages[2]["role"] == "tool"
    assert messages[2]["content"][0]["tool_call_id"] == "toolu-1"
    assert messages[2]["content"][0]["is_error"] is True
    validate_tool_call_closure(messages)


def test_tool_stream_callbacks_receive_start_and_finish_without_result(monkeypatch) -> None:
    tool_call = LLMToolCall(id="toolu-1", name="read", arguments={"path": "a.txt"})
    responses = [
        LLMResponse(
            text="",
            assistant_content=[
                {
                    "type": "tool_call",
                    "id": tool_call.id,
                    "name": tool_call.name,
                    "arguments": dict(tool_call.arguments),
                }
            ],
            tool_calls=[tool_call],
        ),
        LLMResponse(
            text="完成",
            public_text="完成",
            assistant_content=[{"type": "text", "text": "完成"}],
        ),
    ]

    async def fake_chat_with_tools_streaming(**_kwargs: Any) -> LLMResponse:
        return responses.pop(0)

    async def read_tool(**_: Any) -> Any:
        return text_tool_result("secret result")

    tool_events: list[dict[str, Any]] = []

    async def on_tool_start(call: Any) -> None:
        tool_events.append(
            {
                "event": "start",
                "id": call.id,
                "name": call.name,
                "arguments": dict(call.arguments),
            }
        )

    async def on_tool_finish(call: Any, status: str, duration_ms: int) -> None:
        tool_events.append(
            {
                "event": "finish",
                "id": call.id,
                "name": call.name,
                "status": status,
                "duration_ms": duration_ms,
            }
        )

    monkeypatch.setattr(loop_mod, "chat_with_tools_streaming", fake_chat_with_tools_streaming)
    agent = _agent(on_tool_start=on_tool_start, on_tool_finish=on_tool_finish)
    agent.tool_registry.register(
        ToolDefinition(
            name="read",
            description="read",
            parameters={"type": "object", "properties": {}},
            handler=read_tool,
        )
    )

    outcome = asyncio.run(agent.run(_turn_input()))

    assert outcome.status == "done"
    assert [event["event"] for event in tool_events] == ["start", "finish"]
    assert tool_events[0] == {
        "event": "start",
        "id": "toolu-1",
        "name": "read",
        "arguments": {"path": "a.txt"},
    }
    assert tool_events[1]["status"] == "success"
    assert tool_events[1]["duration_ms"] >= 0
    assert "secret result" not in repr(tool_events)


def test_context_checkpoint_order_for_user_tool_call_and_tool_result(monkeypatch) -> None:
    tool_call = LLMToolCall(id="toolu-1", name="read", arguments={"path": "a.txt"})
    responses = [
        LLMResponse(
            text="",
            assistant_content=[
                {
                    "type": "tool_call",
                    "id": tool_call.id,
                    "name": tool_call.name,
                    "arguments": dict(tool_call.arguments),
                }
            ],
            tool_calls=[tool_call],
        ),
        LLMResponse(
            text="完成",
            public_text="完成",
            assistant_content=[{"type": "text", "text": "完成"}],
        ),
    ]
    checkpoint_events: list[tuple[str, str, str]] = []

    async def fake_chat_with_tools_streaming(**_kwargs: Any) -> LLMResponse:
        return responses.pop(0)

    async def checkpoint(operation: str, payload: dict[str, Any]) -> None:
        message = dict(payload.get("message") or {})
        checkpoint_events.append((operation, str(payload.get("reason") or ""), str(message.get("role") or "")))

    async def read_tool(**_: Any) -> Any:
        assert ("append_message", "assistant_tool_call", "assistant") in checkpoint_events
        return text_tool_result("secret result")

    monkeypatch.setattr(loop_mod, "chat_with_tools_streaming", fake_chat_with_tools_streaming)
    agent = _agent()
    agent.tool_registry.register(
        ToolDefinition(
            name="read",
            description="read",
            parameters={"type": "object", "properties": {}},
            handler=read_tool,
        )
    )
    turn = _turn_input()
    turn.context_checkpoint = checkpoint

    outcome = asyncio.run(agent.run(turn))
    messages = load_context_messages(outcome.state_data_patch)

    assert outcome.status == "done"
    assert [event[1:] for event in checkpoint_events] == [
        ("user_message", "user"),
        ("assistant_tool_call", "assistant"),
        ("tool_result", "tool"),
    ]
    assert messages[-1] == {"role": "assistant", "content": [{"type": "text", "text": "完成"}]}


def test_large_tool_result_is_trimmed_before_next_model_request(monkeypatch) -> None:
    tool_call = LLMToolCall(id="toolu-1", name="read", arguments={"path": "huge.txt"})
    responses = [
        LLMResponse(
            text="",
            assistant_content=[
                {
                    "type": "tool_call",
                    "id": tool_call.id,
                    "name": tool_call.name,
                    "arguments": dict(tool_call.arguments),
                }
            ],
            tool_calls=[tool_call],
        ),
        LLMResponse(
            text="完成",
            public_text="完成",
            assistant_content=[{"type": "text", "text": "完成"}],
        ),
    ]

    async def fake_chat_with_tools_streaming(**kwargs: Any) -> LLMResponse:
        if len(responses) == 1:
            sent_messages = list(kwargs.get("messages") or [])
            tool_message = next(message for message in sent_messages if message.get("role") == "tool")
            content = tool_message["content"][0]["content"]
            assert "tokens truncated" in content
            assert len(content.encode("utf-8")) <= 10000 * 4
        return responses.pop(0)

    async def read_tool(**_: Any) -> Any:
        return text_tool_result("A" * 50000)

    monkeypatch.setattr(loop_mod, "chat_with_tools_streaming", fake_chat_with_tools_streaming)
    agent = _agent()
    agent.tool_registry.register(
        ToolDefinition(
            name="read",
            description="read",
            parameters={"type": "object", "properties": {}},
            handler=read_tool,
        )
    )

    outcome = asyncio.run(agent.run(_turn_input()))
    messages = load_context_messages(outcome.state_data_patch)
    tool_content = messages[2]["content"][0]["content"]

    assert outcome.status == "done"
    assert "tokens truncated" in tool_content


def test_cancel_after_partial_tool_completion_closes_remaining_tool_calls(monkeypatch) -> None:
    cancel_after_first_tool = {"value": False}
    called_tools: list[str] = []
    tool_1 = LLMToolCall(id="toolu-1", name="first_tool", arguments={})
    tool_2 = LLMToolCall(id="toolu-2", name="second_tool", arguments={})

    async def cancellation_check() -> bool:
        return bool(cancel_after_first_tool["value"])

    async def fake_chat_with_tools_streaming(**_kwargs: Any) -> LLMResponse:
        return LLMResponse(
            text="",
            assistant_content=[
                {"type": "tool_call", "id": tool_1.id, "name": tool_1.name, "arguments": {}},
                {"type": "tool_call", "id": tool_2.id, "name": tool_2.name, "arguments": {}},
            ],
            tool_calls=[tool_1, tool_2],
        )

    async def first_tool() -> Any:
        called_tools.append("first")
        cancel_after_first_tool["value"] = True
        return text_tool_result("真实结果")

    async def second_tool() -> Any:
        called_tools.append("second")
        return text_tool_result("不应执行")

    monkeypatch.setattr(loop_mod, "chat_with_tools_streaming", fake_chat_with_tools_streaming)
    agent = _agent(cancellation_check=cancellation_check)
    agent.tool_registry.register(
        ToolDefinition(
            name="first_tool",
            description="first",
            parameters={"type": "object", "properties": {}},
            handler=first_tool,
        )
    )
    agent.tool_registry.register(
        ToolDefinition(
            name="second_tool",
            description="second",
            parameters={"type": "object", "properties": {}},
            handler=second_tool,
        )
    )

    outcome = asyncio.run(agent.run(_turn_input()))
    messages = load_context_messages(outcome.state_data_patch)
    tool_blocks = messages[2]["content"]

    assert outcome.status == "cancelled"
    assert called_tools == ["first"]
    assert tool_blocks[0]["tool_call_id"] == "toolu-1"
    assert tool_blocks[0].get("is_error") is not True
    assert tool_blocks[1]["tool_call_id"] == "toolu-2"
    assert tool_blocks[1]["is_error"] is True
    validate_tool_call_closure(messages)


def test_non_retryable_provider_error_stops_after_one_attempt(monkeypatch) -> None:
    calls = {"count": 0}
    user_message = "Kimi Coding 认证失败，请检查 API Key 是否无效或已过期。"

    async def fake_chat_with_tools_streaming(**_kwargs: Any) -> LLMResponse:
        calls["count"] += 1
        raise LLMProviderError(
            "Invalid Authentication",
            provider="kimi_coding",
            status_code=401,
            category="认证错误",
            user_message=user_message,
            retryable=False,
        )

    monkeypatch.setattr(loop_mod, "chat_with_tools_streaming", fake_chat_with_tools_streaming)

    outcome = asyncio.run(_agent().run(_turn_input()))
    messages = load_context_messages(outcome.state_data_patch)

    assert calls["count"] == 1
    assert outcome.status == "error"
    assert outcome.reply == user_message
    assert messages[-1] == {
        "role": "assistant",
        "content": [{"type": "text", "text": user_message}],
    }


def test_retryable_provider_error_uses_step_retry_budget(monkeypatch) -> None:
    calls = {"count": 0}
    user_message = "Kimi Coding 服务暂时异常，请稍后重试。"

    async def fake_chat_with_tools_streaming(**_kwargs: Any) -> LLMResponse:
        calls["count"] += 1
        raise LLMProviderError(
            "503 Service Unavailable",
            provider="kimi_coding",
            status_code=503,
            category="服务端内部错误",
            user_message=user_message,
            retryable=True,
        )

    monkeypatch.setattr(loop_mod, "chat_with_tools_streaming", fake_chat_with_tools_streaming)

    outcome = asyncio.run(_agent().run(_turn_input()))

    assert calls["count"] == loop_mod._LLM_STEP_MAX_ATTEMPTS
    assert outcome.status == "error"
    assert outcome.reply == user_message


def test_deepseek_non_retryable_provider_error_stops_after_one_attempt(monkeypatch) -> None:
    calls = {"count": 0}
    user_message = "DeepSeek 认证失败，请检查 API Key 是否正确。"

    async def fake_chat_with_tools_streaming(**_kwargs: Any) -> LLMResponse:
        calls["count"] += 1
        raise LLMProviderError(
            "Authentication Fails",
            provider="deepseek",
            status_code=401,
            category="认证失败",
            user_message=user_message,
            retryable=False,
        )

    monkeypatch.setattr(loop_mod, "chat_with_tools_streaming", fake_chat_with_tools_streaming)

    outcome = asyncio.run(_agent().run(_turn_input()))
    messages = load_context_messages(outcome.state_data_patch)

    assert calls["count"] == 1
    assert outcome.status == "error"
    assert outcome.reply == user_message
    assert messages[-1] == {
        "role": "assistant",
        "content": [{"type": "text", "text": user_message}],
    }


def test_deepseek_retryable_provider_error_uses_step_retry_budget(monkeypatch) -> None:
    calls = {"count": 0}
    user_message = "DeepSeek 服务器繁忙，请稍后重试。"

    async def fake_chat_with_tools_streaming(**_kwargs: Any) -> LLMResponse:
        calls["count"] += 1
        raise LLMProviderError(
            "Server overloaded",
            provider="deepseek",
            status_code=503,
            category="服务器繁忙",
            user_message=user_message,
            retryable=True,
        )

    monkeypatch.setattr(loop_mod, "chat_with_tools_streaming", fake_chat_with_tools_streaming)

    outcome = asyncio.run(_agent().run(_turn_input()))

    assert calls["count"] == loop_mod._LLM_STEP_MAX_ATTEMPTS
    assert outcome.status == "error"
    assert outcome.reply == user_message


def test_context_overflow_provider_error_triggers_compaction_retry(monkeypatch) -> None:
    calls = {"count": 0}
    triggers: list[str] = []

    async def fake_chat_with_tools_streaming(**_kwargs: Any) -> LLMResponse:
        calls["count"] += 1
        if calls["count"] == 1:
            raise LLMProviderError(
                "Your request exceeded model token limit: 262144",
                provider="kimi_coding",
                status_code=400,
                category="请求格式错误",
                user_message="Kimi Coding 上下文超过限制，已尝试压缩历史后仍无法发送，请缩短输入后重试。",
                retryable=False,
                context_overflow=True,
            )
        return LLMResponse(
            text="完成",
            public_text="完成",
            assistant_content=[{"type": "text", "text": "完成"}],
        )

    async def fake_maybe_compact_history(**kwargs: Any):
        trigger = str(kwargs.get("trigger") or "")
        triggers.append(trigger)
        return dict(kwargs.get("state_data") or {}), trigger == "overflow"

    monkeypatch.setattr(loop_mod, "chat_with_tools_streaming", fake_chat_with_tools_streaming)
    monkeypatch.setattr(loop_mod, "maybe_compact_history", fake_maybe_compact_history)

    outcome = asyncio.run(_agent().run(_turn_input()))

    assert calls["count"] == 2
    assert "overflow" in triggers
    assert outcome.status == "done"
    assert outcome.reply == "完成"


def test_context_canceled_is_not_context_overflow() -> None:
    assert is_context_overflow_error(RuntimeError("context canceled")) is False
    assert is_context_overflow_error(RuntimeError("Your request exceeded model token limit: 262144")) is True
