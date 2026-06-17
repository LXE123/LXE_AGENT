from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

import agent_runtime.turn_handler as turn_handler_mod
from agent_runtime.turn_handler import handle_unified_turn_job
from agent_runtime.types import TurnOutcome


def _session(*, platform: str = "feishu") -> SimpleNamespace:
    return SimpleNamespace(
        session_id="session-1",
        source={"platform": platform},
        state_data={},
        owner_user_id="user-1",
    )


def _job(*, job_kind: str = "turn", raw_data: dict[str, Any] | None = None) -> SimpleNamespace:
    return SimpleNamespace(
        job_id="job-1",
        payload={
            "session_id": "session-1",
            "response_route_id": "route-1",
            "session_key": "key-1",
            "job_id": "job-1",
            "job_kind": job_kind,
            "user_text": "hello",
            "raw_data": dict(raw_data or {}),
            "source": {"platform": "feishu"},
            "user_content_blocks": [],
        },
    )


def _patch_turn_handler_basics(monkeypatch, events: list[str], *, run_error: Exception | None = None) -> None:
    session = _session()

    async def fake_load_agent_session(session_id: str) -> SimpleNamespace:
        assert session_id == "session-1"
        return session

    async def fake_update_agent_session(*_args: Any, **_kwargs: Any) -> None:
        events.append("persist")

    async def fake_run_turn(**_kwargs: Any) -> TurnOutcome:
        events.append("run")
        if run_error is not None:
            raise run_error
        return TurnOutcome(status="done", reply="answer", state_data_patch={})

    monkeypatch.setattr(turn_handler_mod, "load_agent_session", fake_load_agent_session)
    monkeypatch.setattr(turn_handler_mod, "update_agent_session", fake_update_agent_session)
    monkeypatch.setattr(turn_handler_mod, "run_turn", fake_run_turn)
    monkeypatch.setattr(turn_handler_mod, "_should_stream_final_answer", lambda _session: False)


def test_turn_handler_emits_typing_start_and_stop_around_normal_turn(monkeypatch) -> None:
    events: list[str] = []
    _patch_turn_handler_basics(monkeypatch, events)

    async def emit_final(**_kwargs: Any) -> None:
        events.append("final")

    async def emit_typing_indicator(**kwargs: Any) -> None:
        events.append(f"typing:{kwargs['operation']}")

    async def _run() -> None:
        await handle_unified_turn_job(
            _job(),
            emit_final=emit_final,
            emit_typing_indicator=emit_typing_indicator,
        )

    asyncio.run(_run())

    assert events == ["typing:start", "run", "persist", "final", "typing:stop"]


def test_turn_handler_stops_typing_after_run_error(monkeypatch) -> None:
    events: list[str] = []
    _patch_turn_handler_basics(monkeypatch, events, run_error=RuntimeError("boom"))

    async def emit_final(**kwargs: Any) -> None:
        events.append(f"final:{kwargs['content']}")

    async def emit_typing_indicator(**kwargs: Any) -> None:
        events.append(f"typing:{kwargs['operation']}")

    async def _run() -> None:
        await handle_unified_turn_job(
            _job(),
            emit_final=emit_final,
            emit_typing_indicator=emit_typing_indicator,
        )

    asyncio.run(_run())

    assert events[0:2] == ["typing:start", "run"]
    assert events[-1] == "typing:stop"
    assert any(item.startswith("final:执行失败: boom") for item in events)


def test_turn_handler_stops_typing_when_final_emit_fails(monkeypatch) -> None:
    events: list[str] = []
    _patch_turn_handler_basics(monkeypatch, events)

    async def emit_final(**_kwargs: Any) -> None:
        events.append("final")
        raise RuntimeError("send failed")

    async def emit_typing_indicator(**kwargs: Any) -> None:
        events.append(f"typing:{kwargs['operation']}")

    async def _run() -> None:
        await handle_unified_turn_job(
            _job(),
            emit_final=emit_final,
            emit_typing_indicator=emit_typing_indicator,
        )

    asyncio.run(_run())

    assert events == ["typing:start", "run", "persist", "final", "typing:stop"]


def test_turn_handler_skips_typing_for_skip_typing_flag(monkeypatch) -> None:
    events: list[str] = []
    _patch_turn_handler_basics(monkeypatch, events)

    async def emit_final(**_kwargs: Any) -> None:
        events.append("final")

    async def emit_typing_indicator(**kwargs: Any) -> None:
        events.append(f"typing:{kwargs['operation']}")

    async def _run() -> None:
        await handle_unified_turn_job(
            _job(raw_data={"skip_typing": True}),
            emit_final=emit_final,
            emit_typing_indicator=emit_typing_indicator,
        )

    asyncio.run(_run())

    assert events == ["run", "persist", "final"]


def test_turn_handler_skips_typing_for_heartbeat(monkeypatch) -> None:
    events: list[str] = []
    _patch_turn_handler_basics(monkeypatch, events)

    async def fake_pop_pending_events(session_id: str) -> list[dict[str, Any]]:
        assert session_id == "session-1"
        return []

    async def emit_typing_indicator(**kwargs: Any) -> None:
        events.append(f"typing:{kwargs['operation']}")

    monkeypatch.setattr(turn_handler_mod, "pop_agent_session_pending_events", fake_pop_pending_events)

    async def _run() -> None:
        await handle_unified_turn_job(
            _job(job_kind="heartbeat", raw_data={"heartbeat_reason": "exec-event"}),
            emit_typing_indicator=emit_typing_indicator,
        )

    asyncio.run(_run())

    assert events == ["persist"]
