from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass

import agent_runtime.final_answer_streamer as streamer_mod
from agent_runtime.final_answer_streamer import FinalAnswerStreamer
from shared.llm.events import LLMStreamEvent


@dataclass(frozen=True)
class EmitCall:
    session_id: str
    response_route_id: str
    channel: str
    state: str
    seq: int
    content: str
    emit_id: str
    thinking: str = ""
    redacted_thinking_count: int = 0
    thinking_elapsed_ms: int = 0


def _run(coro):
    return asyncio.run(coro)


async def _wait_until(predicate, *, timeout_s: float = 1.0) -> None:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if predicate():
            return
        await asyncio.sleep(0.01)
    raise AssertionError("condition was not met before timeout")


def test_push_delta_does_not_wait_for_slow_emit() -> None:
    async def scenario() -> None:
        calls: list[EmitCall] = []
        first_emit_started = asyncio.Event()
        release_first_emit = asyncio.Event()

        async def emit_stream(
            session_id: str,
            response_route_id: str,
            channel: str,
            state: str,
            seq: int,
            content: str,
            emit_id: str,
            *,
            thinking: str = "",
            redacted_thinking_count: int = 0,
            thinking_elapsed_ms: int = 0,
        ) -> None:
            calls.append(
                EmitCall(
                    session_id,
                    response_route_id,
                    channel,
                    state,
                    seq,
                    content,
                    emit_id,
                    thinking,
                    redacted_thinking_count,
                    thinking_elapsed_ms,
                )
            )
            first_emit_started.set()
            if seq == 1:
                await release_first_emit.wait()

        streamer = FinalAnswerStreamer(
            session_id="session-1",
            response_route_id="route-1",
            emit_stream=emit_stream,
            min_interval_ms=0,
            emit_id="emit-1",
        )

        await streamer.push_delta("a")
        await asyncio.wait_for(first_emit_started.wait(), timeout=1)

        started_at = time.perf_counter()
        await streamer.push_delta("b")
        elapsed = time.perf_counter() - started_at

        release_first_emit.set()
        await streamer.finish("ab")

        assert elapsed < 0.05
        assert calls[-1].state == "final"
        assert calls[-1].content == "ab"

    _run(scenario())


def test_deltas_merge_to_latest_buffer_while_emit_is_in_flight() -> None:
    async def scenario() -> None:
        calls: list[EmitCall] = []
        first_emit_started = asyncio.Event()
        release_first_emit = asyncio.Event()

        async def emit_stream(
            session_id: str,
            response_route_id: str,
            channel: str,
            state: str,
            seq: int,
            content: str,
            emit_id: str,
            *,
            thinking: str = "",
            redacted_thinking_count: int = 0,
            thinking_elapsed_ms: int = 0,
        ) -> None:
            calls.append(
                EmitCall(
                    session_id,
                    response_route_id,
                    channel,
                    state,
                    seq,
                    content,
                    emit_id,
                    thinking,
                    redacted_thinking_count,
                    thinking_elapsed_ms,
                )
            )
            if seq == 1:
                first_emit_started.set()
                await release_first_emit.wait()

        streamer = FinalAnswerStreamer(
            session_id="session-1",
            response_route_id="route-1",
            emit_stream=emit_stream,
            min_interval_ms=0,
            emit_id="emit-1",
        )

        await streamer.push_delta("a")
        await asyncio.wait_for(first_emit_started.wait(), timeout=1)
        await streamer.push_delta("b")
        await streamer.push_delta("c")

        release_first_emit.set()
        await streamer.finish("abc")

        delta_contents = [call.content for call in calls if call.state == "delta"]
        assert delta_contents == ["a", "abc"]
        assert calls[-1].state == "final"
        assert calls[-1].content == "abc"

    _run(scenario())


def test_only_one_emit_is_in_flight_at_a_time() -> None:
    async def scenario() -> None:
        first_emit_started = asyncio.Event()
        release_first_emit = asyncio.Event()
        active_emit_count = 0
        max_active_emit_count = 0

        async def emit_stream(
            _session_id: str,
            _response_route_id: str,
            _channel: str,
            _state: str,
            seq: int,
            _content: str,
            _emit_id: str,
            *,
            thinking: str = "",
            redacted_thinking_count: int = 0,
            thinking_elapsed_ms: int = 0,
        ) -> None:
            _ = thinking, redacted_thinking_count, thinking_elapsed_ms
            nonlocal active_emit_count, max_active_emit_count
            active_emit_count += 1
            max_active_emit_count = max(max_active_emit_count, active_emit_count)
            if seq == 1:
                first_emit_started.set()
                await release_first_emit.wait()
            active_emit_count -= 1

        streamer = FinalAnswerStreamer(
            session_id="session-1",
            response_route_id="route-1",
            emit_stream=emit_stream,
            min_interval_ms=0,
            emit_id="emit-1",
        )

        await streamer.push_delta("a")
        await asyncio.wait_for(first_emit_started.wait(), timeout=1)
        await streamer.push_delta("b")
        await streamer.push_delta("c")

        release_first_emit.set()
        await streamer.finish("abc")

        assert max_active_emit_count == 1

    _run(scenario())


def test_finish_waits_for_final_full_content_emit() -> None:
    async def scenario() -> None:
        calls: list[EmitCall] = []
        first_emit_started = asyncio.Event()
        release_first_emit = asyncio.Event()

        async def emit_stream(
            session_id: str,
            response_route_id: str,
            channel: str,
            state: str,
            seq: int,
            content: str,
            emit_id: str,
            *,
            thinking: str = "",
            redacted_thinking_count: int = 0,
            thinking_elapsed_ms: int = 0,
        ) -> None:
            calls.append(
                EmitCall(
                    session_id,
                    response_route_id,
                    channel,
                    state,
                    seq,
                    content,
                    emit_id,
                    thinking,
                    redacted_thinking_count,
                    thinking_elapsed_ms,
                )
            )
            if seq == 1:
                first_emit_started.set()
                await release_first_emit.wait()

        streamer = FinalAnswerStreamer(
            session_id="session-1",
            response_route_id="route-1",
            emit_stream=emit_stream,
            min_interval_ms=0,
            emit_id="emit-1",
        )

        await streamer.push_delta("hello")
        await asyncio.wait_for(first_emit_started.wait(), timeout=1)

        finish_task = asyncio.create_task(streamer.finish("hello"))
        await asyncio.sleep(0.02)

        assert not finish_task.done()
        release_first_emit.set()
        await asyncio.wait_for(finish_task, timeout=1)
        assert calls[-1].state == "final"
        assert calls[-1].content == "hello"

    _run(scenario())


def test_fail_emits_error_state() -> None:
    async def scenario() -> list[EmitCall]:
        calls: list[EmitCall] = []

        async def emit_stream(
            session_id: str,
            response_route_id: str,
            channel: str,
            state: str,
            seq: int,
            content: str,
            emit_id: str,
            *,
            thinking: str = "",
            redacted_thinking_count: int = 0,
            thinking_elapsed_ms: int = 0,
        ) -> None:
            calls.append(
                EmitCall(
                    session_id,
                    response_route_id,
                    channel,
                    state,
                    seq,
                    content,
                    emit_id,
                    thinking,
                    redacted_thinking_count,
                    thinking_elapsed_ms,
                )
            )

        streamer = FinalAnswerStreamer(
            session_id="session-1",
            response_route_id="route-1",
            emit_stream=emit_stream,
            min_interval_ms=0,
            emit_id="emit-1",
        )

        await streamer.fail("failed")
        return calls

    calls = _run(scenario())
    assert calls == [
        EmitCall("session-1", "route-1", "final_answer", "error", 1, "failed", "emit-1"),
    ]


def test_cancel_preserves_already_sent_content() -> None:
    async def scenario() -> list[EmitCall]:
        calls: list[EmitCall] = []

        async def emit_stream(
            session_id: str,
            response_route_id: str,
            channel: str,
            state: str,
            seq: int,
            content: str,
            emit_id: str,
            *,
            thinking: str = "",
            redacted_thinking_count: int = 0,
            thinking_elapsed_ms: int = 0,
        ) -> None:
            calls.append(
                EmitCall(
                    session_id,
                    response_route_id,
                    channel,
                    state,
                    seq,
                    content,
                    emit_id,
                    thinking,
                    redacted_thinking_count,
                    thinking_elapsed_ms,
                )
            )

        streamer = FinalAnswerStreamer(
            session_id="session-1",
            response_route_id="route-1",
            emit_stream=emit_stream,
            min_interval_ms=0,
            emit_id="emit-1",
        )

        await streamer.push_delta("hello")
        await _wait_until(lambda: streamer.delivered_any)
        await streamer.cancel()
        return calls

    calls = _run(scenario())
    assert calls == [
        EmitCall("session-1", "route-1", "final_answer", "delta", 1, "hello", "emit-1"),
        EmitCall("session-1", "route-1", "final_answer", "final", 2, "hello", "emit-1"),
    ]


def test_push_event_separates_answer_thinking_and_redacted_count() -> None:
    async def scenario() -> list[EmitCall]:
        calls: list[EmitCall] = []

        async def emit_stream(
            session_id: str,
            response_route_id: str,
            channel: str,
            state: str,
            seq: int,
            content: str,
            emit_id: str,
            *,
            thinking: str = "",
            redacted_thinking_count: int = 0,
            thinking_elapsed_ms: int = 0,
        ) -> None:
            calls.append(
                EmitCall(
                    session_id,
                    response_route_id,
                    channel,
                    state,
                    seq,
                    content,
                    emit_id,
                    thinking,
                    redacted_thinking_count,
                    thinking_elapsed_ms,
                )
            )

        streamer = FinalAnswerStreamer(
            session_id="session-1",
            response_route_id="route-1",
            emit_stream=emit_stream,
            min_interval_ms=0,
            emit_id="emit-1",
        )

        await streamer.push_event(LLMStreamEvent(event_type="thinking_delta", thinking_text="plan"))
        await streamer.push_event(LLMStreamEvent(event_type="redacted_thinking", redacted_data="encrypted"))
        await streamer.push_event(LLMStreamEvent(event_type="text_delta", text="answer"))
        await streamer.finish("answer")
        return calls

    calls = _run(scenario())
    assert calls[-1].state == "final"
    assert calls[-1].content == "answer"
    assert calls[-1].thinking == "plan"
    assert calls[-1].redacted_thinking_count == 1
    assert all("plan" not in call.content for call in calls)
    assert all("encrypted" not in call.thinking for call in calls)


def test_push_event_tracks_thinking_elapsed_until_first_answer(monkeypatch) -> None:
    current_time = {"value": 10.0}

    def fake_monotonic() -> float:
        return current_time["value"]

    monkeypatch.setattr(streamer_mod.time, "monotonic", fake_monotonic)

    async def scenario() -> list[EmitCall]:
        calls: list[EmitCall] = []

        async def emit_stream(
            session_id: str,
            response_route_id: str,
            channel: str,
            state: str,
            seq: int,
            content: str,
            emit_id: str,
            *,
            thinking: str = "",
            redacted_thinking_count: int = 0,
            thinking_elapsed_ms: int = 0,
        ) -> None:
            calls.append(
                EmitCall(
                    session_id,
                    response_route_id,
                    channel,
                    state,
                    seq,
                    content,
                    emit_id,
                    thinking,
                    redacted_thinking_count,
                    thinking_elapsed_ms,
                )
            )

        streamer = FinalAnswerStreamer(
            session_id="session-1",
            response_route_id="route-1",
            emit_stream=emit_stream,
            min_interval_ms=0,
            emit_id="emit-1",
        )

        await streamer.push_event(LLMStreamEvent(event_type="thinking_delta", thinking_text="plan"))
        current_time["value"] = 13.2
        await streamer.push_event(LLMStreamEvent(event_type="text_delta", text="answer"))
        await streamer.finish("answer")
        return calls

    calls = _run(scenario())
    assert calls[-1].state == "final"
    assert calls[-1].thinking_elapsed_ms == 3200


def test_redacted_only_thinking_elapsed_is_locked_on_finish(monkeypatch) -> None:
    current_time = {"value": 20.0}

    def fake_monotonic() -> float:
        return current_time["value"]

    monkeypatch.setattr(streamer_mod.time, "monotonic", fake_monotonic)

    async def scenario() -> list[EmitCall]:
        calls: list[EmitCall] = []

        async def emit_stream(
            session_id: str,
            response_route_id: str,
            channel: str,
            state: str,
            seq: int,
            content: str,
            emit_id: str,
            *,
            thinking: str = "",
            redacted_thinking_count: int = 0,
            thinking_elapsed_ms: int = 0,
        ) -> None:
            calls.append(
                EmitCall(
                    session_id,
                    response_route_id,
                    channel,
                    state,
                    seq,
                    content,
                    emit_id,
                    thinking,
                    redacted_thinking_count,
                    thinking_elapsed_ms,
                )
            )

        streamer = FinalAnswerStreamer(
            session_id="session-1",
            response_route_id="route-1",
            emit_stream=emit_stream,
            min_interval_ms=0,
            emit_id="emit-1",
        )

        await streamer.push_event(LLMStreamEvent(event_type="redacted_thinking", redacted_data="encrypted"))
        current_time["value"] = 24.25
        await streamer.finish("")
        return calls

    calls = _run(scenario())
    assert calls[-1].state == "final"
    assert calls[-1].redacted_thinking_count == 1
    assert calls[-1].thinking_elapsed_ms == 4250
    assert all("encrypted" not in call.thinking for call in calls)


def test_legacy_push_delta_keeps_thinking_elapsed_zero() -> None:
    async def scenario() -> list[EmitCall]:
        calls: list[EmitCall] = []

        async def emit_stream(
            session_id: str,
            response_route_id: str,
            channel: str,
            state: str,
            seq: int,
            content: str,
            emit_id: str,
            *,
            thinking: str = "",
            redacted_thinking_count: int = 0,
            thinking_elapsed_ms: int = 0,
        ) -> None:
            calls.append(
                EmitCall(
                    session_id,
                    response_route_id,
                    channel,
                    state,
                    seq,
                    content,
                    emit_id,
                    thinking,
                    redacted_thinking_count,
                    thinking_elapsed_ms,
                )
            )

        streamer = FinalAnswerStreamer(
            session_id="session-1",
            response_route_id="route-1",
            emit_stream=emit_stream,
            min_interval_ms=0,
            emit_id="emit-1",
        )

        await streamer.push_delta("answer")
        await streamer.finish("answer")
        return calls

    calls = _run(scenario())
    assert calls[-1].state == "final"
    assert calls[-1].thinking_elapsed_ms == 0
