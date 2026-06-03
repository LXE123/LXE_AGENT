from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass

from agent_runtime.final_answer_streamer import FinalAnswerStreamer


@dataclass(frozen=True)
class EmitCall:
    session_id: str
    card_id: str
    channel: str
    state: str
    seq: int
    content: str
    emit_id: str


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
            card_id: str,
            channel: str,
            state: str,
            seq: int,
            content: str,
            emit_id: str,
        ) -> None:
            calls.append(EmitCall(session_id, card_id, channel, state, seq, content, emit_id))
            first_emit_started.set()
            if seq == 1:
                await release_first_emit.wait()

        streamer = FinalAnswerStreamer(
            session_id="session-1",
            card_id="card-1",
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
            card_id: str,
            channel: str,
            state: str,
            seq: int,
            content: str,
            emit_id: str,
        ) -> None:
            calls.append(EmitCall(session_id, card_id, channel, state, seq, content, emit_id))
            if seq == 1:
                first_emit_started.set()
                await release_first_emit.wait()

        streamer = FinalAnswerStreamer(
            session_id="session-1",
            card_id="card-1",
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
            _card_id: str,
            _channel: str,
            _state: str,
            seq: int,
            _content: str,
            _emit_id: str,
        ) -> None:
            nonlocal active_emit_count, max_active_emit_count
            active_emit_count += 1
            max_active_emit_count = max(max_active_emit_count, active_emit_count)
            if seq == 1:
                first_emit_started.set()
                await release_first_emit.wait()
            active_emit_count -= 1

        streamer = FinalAnswerStreamer(
            session_id="session-1",
            card_id="card-1",
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
            card_id: str,
            channel: str,
            state: str,
            seq: int,
            content: str,
            emit_id: str,
        ) -> None:
            calls.append(EmitCall(session_id, card_id, channel, state, seq, content, emit_id))
            if seq == 1:
                first_emit_started.set()
                await release_first_emit.wait()

        streamer = FinalAnswerStreamer(
            session_id="session-1",
            card_id="card-1",
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
            card_id: str,
            channel: str,
            state: str,
            seq: int,
            content: str,
            emit_id: str,
        ) -> None:
            calls.append(EmitCall(session_id, card_id, channel, state, seq, content, emit_id))

        streamer = FinalAnswerStreamer(
            session_id="session-1",
            card_id="card-1",
            emit_stream=emit_stream,
            min_interval_ms=0,
            emit_id="emit-1",
        )

        await streamer.fail("failed")
        return calls

    calls = _run(scenario())
    assert calls == [
        EmitCall("session-1", "card-1", "final_answer", "error", 1, "failed", "emit-1"),
    ]


def test_cancel_preserves_already_sent_content() -> None:
    async def scenario() -> list[EmitCall]:
        calls: list[EmitCall] = []

        async def emit_stream(
            session_id: str,
            card_id: str,
            channel: str,
            state: str,
            seq: int,
            content: str,
            emit_id: str,
        ) -> None:
            calls.append(EmitCall(session_id, card_id, channel, state, seq, content, emit_id))

        streamer = FinalAnswerStreamer(
            session_id="session-1",
            card_id="card-1",
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
        EmitCall("session-1", "card-1", "final_answer", "delta", 1, "hello", "emit-1"),
        EmitCall("session-1", "card-1", "final_answer", "final", 2, "hello", "emit-1"),
    ]
