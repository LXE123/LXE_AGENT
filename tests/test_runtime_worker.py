from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
from typing import Any

import pytest

import agent_runtime.turn_handler as turn_handler_mod
from agent_runtime.emit_bus import (
    emit_final,
    emit_stream,
    request_heartbeat_wake,
    send_emit_request,
)
from agent_runtime.worker import RuntimeWorker
from shared.agent_io import AgentJob, EmitRequest
from shared.db import client as shared_db
from shared.db.sqlite import bootstrap


REQUEST_KINDS = {
    "worker.hello",
    "health",
    "session.ensure",
    "session.rebind",
    "response_route.upsert",
    "pending_events.pop",
    "pending_events.append",
    "turn.start",
    "turn.cancel",
    "turn.steer",
    "maintenance.run",
    "dashboard.query",
    "worker.shutdown",
}


def _envelope(
    kind: str,
    payload: dict[str, Any] | None = None,
    *,
    message_id: str | None = None,
    run_id: str | None = None,
) -> dict[str, Any]:
    return {
        "protocol_version": "1",
        "message_id": message_id or f"request-{kind}",
        "reply_to": None,
        "run_id": run_id,
        "seq": 0,
        "kind": kind,
        "payload": dict(payload or {}),
    }


def _job(
    *,
    job_id: str = "run-1",
    session_id: str = "session-1",
    job_kind: str = "turn",
) -> dict[str, Any]:
    return {
        "job_id": job_id,
        "session_id": session_id,
        "session_key": f"agent:main:test:dm:{session_id}",
        "response_route_id": f"route-{session_id}",
        "user_id": f"user-{session_id}",
        "conversation_id": f"chat-{session_id}",
        "is_group": False,
        "message_id": f"message-{job_id}",
        "user_input": "hello",
        "job_kind": job_kind,
        "sender_nick": "Tester",
        "source": {
            "platform": "test",
            "chat_id": f"chat-{session_id}",
            "chat_type": "dm",
            "user_id": f"user-{session_id}",
        },
        "raw_data": {},
        "user_content_blocks": [],
    }


def _source(*, platform: str = "test", chat_id: str = "chat-1") -> dict[str, Any]:
    return {
        "platform": platform,
        "chat_id": chat_id,
        "chat_type": "dm",
        "user_id": "user-1",
        "user_name": "Tester",
    }


def _route(*, route_id: str = "route-1", platform: str = "test") -> dict[str, Any]:
    return {
        "response_route_id": route_id,
        "platform": platform,
        "user_id": "user-1",
        "conversation_id": "chat-1",
        "is_group": False,
        "message_id": "message-1",
        "sender_nick": "Tester",
        "source": _source(platform=platform),
        "raw_data": {"platform": platform},
    }


async def _started_worker(
    outputs: list[dict[str, Any]],
    **kwargs: Any,
) -> RuntimeWorker:
    async def write_envelope(envelope: dict[str, Any]) -> None:
        outputs.append(envelope)

    worker = RuntimeWorker(
        write_envelope=write_envelope,
        initialize_storage=lambda: None,
        close_storage=lambda: None,
        **kwargs,
    )
    await worker.start()
    return worker


async def _wait_for_output(
    outputs: list[dict[str, Any]],
    *,
    kind: str,
    run_id: str | None = None,
    timeout: float = 2.0,
) -> dict[str, Any]:
    async def find() -> dict[str, Any]:
        while True:
            for output in outputs:
                if output["kind"] != kind:
                    continue
                if run_id is not None and output["run_id"] != run_id:
                    continue
                return output
            await asyncio.sleep(0)

    return await asyncio.wait_for(find(), timeout=timeout)


async def _wait_for_reply(
    outputs: list[dict[str, Any]],
    reply_to: str,
    *,
    timeout: float = 2.0,
) -> dict[str, Any]:
    async def find() -> dict[str, Any]:
        while True:
            for output in outputs:
                if output["reply_to"] == reply_to:
                    return output
            await asyncio.sleep(0)

    return await asyncio.wait_for(find(), timeout=timeout)


@pytest.fixture
def isolated_db(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    db_path = tmp_path / "worker.sqlite3"
    monkeypatch.setenv("LXE_SQLITE_DB_PATH", str(db_path))
    bootstrap.init_schema()
    return db_path


def test_worker_hello_and_health_are_correlated() -> None:
    async def run() -> None:
        outputs: list[dict[str, Any]] = []
        worker = await _started_worker(outputs)
        try:
            await worker.handle_message(_envelope("worker.hello", message_id="hello-1"))
            await worker.handle_message(_envelope("health", message_id="health-1"))

            hello, health = outputs
            assert hello["kind"] == "worker.hello.result"
            assert hello["reply_to"] == "hello-1"
            assert hello["payload"]["protocol_version"] == "1"
            assert hello["payload"]["worker_pid"] == os.getpid()
            assert set(hello["payload"]["capabilities"]["request_kinds"]) == REQUEST_KINDS
            assert health["kind"] == "health.result"
            assert health["reply_to"] == "health-1"
            assert health["payload"] == {"ready": True, "active_run_count": 0}
            assert hello["seq"] < health["seq"]
        finally:
            await worker.shutdown()

    asyncio.run(run())


def test_invalid_envelope_returns_structured_error_and_worker_stays_ready() -> None:
    async def run() -> None:
        outputs: list[dict[str, Any]] = []
        worker = await _started_worker(outputs)
        try:
            invalid = _envelope("health", message_id="bad-1")
            invalid["protocol_version"] = "2"
            await worker.handle_message(invalid)
            await worker.handle_line("{not-json}\n")
            await worker.handle_message(_envelope("health", message_id="health-after-error"))

            assert outputs[0]["kind"] == "error"
            assert outputs[0]["reply_to"] == "bad-1"
            assert outputs[0]["payload"]["code"] == "invalid_envelope"
            assert outputs[0]["payload"]["request_kind"] == "health"
            assert "traceback" not in json.dumps(outputs[0]).lower()
            assert outputs[1]["kind"] == "error"
            assert outputs[1]["payload"]["code"] == "invalid_json"
            assert outputs[2]["kind"] == "health.result"
            assert outputs[2]["payload"]["ready"] is True
        finally:
            await worker.shutdown()

    asyncio.run(run())


def test_session_ensure_and_rebind_match_shared_db_behavior(isolated_db: Path) -> None:
    _ = isolated_db

    async def run() -> None:
        outputs: list[dict[str, Any]] = []
        worker = await _started_worker(outputs)
        try:
            await worker.handle_message(
                _envelope(
                    "session.ensure",
                    {
                        "session_id": "session-ensure",
                        "source": _source(),
                        "entry_text": "first turn",
                        "response_route": _route(),
                    },
                    message_id="ensure-1",
                )
            )
            direct_record = await shared_db.load_agent_session_record("session-ensure")
            assert direct_record is not None
            assert outputs[-1]["kind"] == "session.ensure.result"
            assert outputs[-1]["payload"] == {
                "session_id": direct_record.session_id,
                "source": direct_record.source,
                "created": True,
            }

            rebound_source = _source(platform="feishu", chat_id="chat-rebound")
            rebound_route = _route(route_id="route-rebound", platform="feishu")
            rebound_route["conversation_id"] = "chat-rebound"
            rebound_route["source"] = rebound_source
            await worker.handle_message(
                _envelope(
                    "session.rebind",
                    {
                        "session_id": "session-ensure",
                        "source": rebound_source,
                        "response_route": rebound_route,
                    },
                    message_id="rebind-1",
                )
            )

            direct_rebound = await shared_db.load_agent_session_record("session-ensure")
            direct_route = await shared_db.load_response_route_context("route-rebound")
            assert direct_rebound is not None
            assert direct_route is not None
            assert direct_rebound.source == rebound_source
            assert direct_route.platform == "feishu"
            assert outputs[-1]["kind"] == "session.rebind.result"
            assert outputs[-1]["payload"]["source"] == direct_rebound.source
        finally:
            await worker.shutdown()

    asyncio.run(run())


def test_response_route_and_pending_event_operations_use_shared_db_validation(
    isolated_db: Path,
) -> None:
    _ = isolated_db

    async def run() -> None:
        outputs: list[dict[str, Any]] = []
        worker = await _started_worker(outputs)
        try:
            await worker.handle_message(
                _envelope(
                    "session.ensure",
                    {"session_id": "session-events", "source": _source(), "entry_text": ""},
                )
            )
            await worker.handle_message(
                _envelope("response_route.upsert", _route(route_id="route-events"))
            )
            stored_route = await shared_db.load_response_route_context("route-events")
            assert stored_route is not None
            assert stored_route.owner_user_id == "user-1"

            event = {
                "event_id": "event-1",
                "job_id": "background-1",
                "created_at": 123,
                "text": "background complete",
            }
            await worker.handle_message(
                _envelope(
                    "pending_events.append",
                    {"session_id": "session-events", "event": event},
                    message_id="append-1",
                )
            )
            await worker.handle_message(
                _envelope(
                    "pending_events.pop",
                    {"session_id": "session-events"},
                    message_id="pop-1",
                )
            )
            assert outputs[-2]["payload"] == {"appended": True}
            assert outputs[-1]["payload"] == {"events": [event]}
            assert await shared_db.pop_agent_session_pending_events("session-events") == []

            await worker.handle_message(
                _envelope(
                    "pending_events.append",
                    {"session_id": "session-events", "event": {"text": "invalid"}},
                    message_id="append-invalid",
                )
            )
            assert outputs[-1]["kind"] == "error"
            assert outputs[-1]["payload"]["code"] == "invalid_request"
        finally:
            await worker.shutdown()

    asyncio.run(run())


def test_runtime_stream_final_typing_and_heartbeat_events_are_correlated() -> None:
    async def fake_turn_handler(
        job: AgentJob,
        *,
        run_handle: Any,
        emit_final: Any,
        emit_stream: Any,
        emit_typing_indicator: Any,
    ) -> None:
        assert run_handle.job_id == job.job_id
        await emit_typing_indicator(
            session_id=job.session_id,
            response_route_id=job.response_route_id,
            operation="start",
            emit_id="typing-1",
        )
        await emit_stream(
            session_id=job.session_id,
            response_route_id=job.response_route_id,
            stream_type="final_answer",
            state="delta",
            seq=1,
            content="hel",
            emit_id="stream-1",
        )
        await emit_final(
            session_id=job.session_id,
            response_route_id=job.response_route_id,
            content="hello",
            emit_id="final-1",
        )
        await request_heartbeat_wake(
            session_id=job.session_id,
            response_route_id=job.response_route_id,
            reason="exec-event",
        )
        await emit_typing_indicator(
            session_id=job.session_id,
            response_route_id=job.response_route_id,
            operation="stop",
            emit_id="typing-2",
        )

    async def run() -> None:
        outputs: list[dict[str, Any]] = []
        worker = await _started_worker(outputs, turn_handler=fake_turn_handler)
        try:
            request = _envelope(
                "turn.start",
                _job(),
                message_id="start-1",
                run_id="run-1",
            )
            await worker.handle_message(request)
            await _wait_for_output(outputs, kind="runtime.turn.completed", run_id="run-1")

            events = [item for item in outputs if item["kind"].startswith("runtime.")]
            assert [item["kind"] for item in events] == [
                "runtime.typing",
                "runtime.emit",
                "runtime.emit",
                "runtime.heartbeat_wake",
                "runtime.typing",
                "runtime.turn.completed",
            ]
            assert [item["payload"]["emit_kind"] for item in events if item["kind"] == "runtime.emit"] == [
                "stream",
                "final",
            ]
            assert all(item["run_id"] == "run-1" for item in events)
            assert all(item["reply_to"] == "start-1" for item in events)
            assert events[-1]["payload"] == {
                "session_id": "session-1",
                "status": "completed",
                "remaining_steering": [],
            }
        finally:
            await worker.shutdown()

    asyncio.run(run())


def test_heartbeat_turn_with_no_pending_events_is_a_provider_noop(
    isolated_db: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _ = isolated_db
    provider_calls = 0

    async def fail_if_provider_runs(**_kwargs: Any) -> None:
        nonlocal provider_calls
        provider_calls += 1
        raise AssertionError("heartbeat without pending events must not invoke provider")

    monkeypatch.setattr(turn_handler_mod, "run_turn", fail_if_provider_runs)

    async def run() -> None:
        outputs: list[dict[str, Any]] = []
        worker = await _started_worker(outputs)
        try:
            await worker.handle_message(
                _envelope(
                    "session.ensure",
                    {"session_id": "session-heartbeat", "source": _source(), "entry_text": ""},
                )
            )
            heartbeat_job = _job(
                job_id="heartbeat-run",
                session_id="session-heartbeat",
                job_kind="heartbeat",
            )
            heartbeat_job["raw_data"] = {"heartbeat_reason": "exec-event"}
            await worker.handle_message(
                _envelope(
                    "turn.start",
                    heartbeat_job,
                    message_id="heartbeat-start",
                    run_id="heartbeat-run",
                )
            )
            completion = await _wait_for_output(
                outputs,
                kind="runtime.turn.completed",
                run_id="heartbeat-run",
            )
            assert completion["payload"]["status"] == "completed"
            assert provider_calls == 0
            assert not any(item["kind"] == "runtime.emit" for item in outputs)
        finally:
            await worker.shutdown()

    asyncio.run(run())


def test_turn_cancel_reuses_run_handle_cancellation() -> None:
    provider_cancelled = asyncio.Event()

    async def fake_turn_handler(job: AgentJob, *, run_handle: Any, **_kwargs: Any) -> None:
        _ = job
        run_handle.set_provider_cancel_handle(provider_cancelled.set)
        await run_handle.cancel_event.wait()

    async def run() -> None:
        outputs: list[dict[str, Any]] = []
        worker = await _started_worker(outputs, turn_handler=fake_turn_handler)
        try:
            await worker.handle_message(
                _envelope("turn.start", _job(), message_id="start-cancel", run_id="run-1")
            )
            await asyncio.sleep(0)
            await worker.handle_message(
                _envelope(
                    "turn.steer",
                    {"session_id": "session-1", "text": "drop after cancel"},
                    message_id="steer-before-cancel",
                    run_id="run-1",
                )
            )
            await worker.handle_message(
                _envelope(
                    "turn.cancel",
                    {"session_id": "session-1"},
                    message_id="cancel-1",
                    run_id="run-1",
                )
            )
            completion = await _wait_for_output(
                outputs,
                kind="runtime.turn.completed",
                run_id="run-1",
            )
            assert provider_cancelled.is_set()
            cancel_reply = next(item for item in outputs if item["reply_to"] == "cancel-1")
            assert cancel_reply["payload"] == {"cancelled": True, "session_id": "session-1"}
            assert completion["payload"]["status"] == "cancelled"
            assert "remaining_steering" not in completion["payload"]
        finally:
            await worker.shutdown()

    asyncio.run(run())


def test_turn_steer_reuses_active_run_handle() -> None:
    received: list[dict[str, str]] = []
    ready = asyncio.Event()

    async def fake_turn_handler(job: AgentJob, *, run_handle: Any, **_kwargs: Any) -> None:
        _ = job
        ready.set()
        while not received:
            received.extend(run_handle.drain_steering())
            await asyncio.sleep(0)

    async def run() -> None:
        outputs: list[dict[str, Any]] = []
        worker = await _started_worker(outputs, turn_handler=fake_turn_handler)
        try:
            await worker.handle_message(
                _envelope("turn.start", _job(), message_id="start-steer", run_id="run-1")
            )
            await ready.wait()
            await worker.handle_message(
                _envelope(
                    "turn.steer",
                    {
                        "session_id": "session-1",
                        "text": "change direction",
                        "response_route_id": "route-steer",
                        "message_id": "message-steer",
                    },
                    message_id="steer-1",
                    run_id="run-1",
                )
            )
            await _wait_for_output(outputs, kind="runtime.turn.completed", run_id="run-1")
            assert received == [
                {
                    "text": "change direction",
                    "response_route_id": "route-steer",
                    "message_id": "message-steer",
                }
            ]
            steer_reply = next(item for item in outputs if item["reply_to"] == "steer-1")
            assert steer_reply["payload"] == {"accepted": True, "session_id": "session-1"}
        finally:
            await worker.shutdown()

    asyncio.run(run())


def test_steering_accepted_before_closure_is_handed_off_in_completion() -> None:
    release_turn = asyncio.Event()

    async def fake_turn_handler(**_kwargs: Any) -> None:
        await release_turn.wait()

    async def run() -> None:
        outputs: list[dict[str, Any]] = []
        worker = await _started_worker(outputs, turn_handler=fake_turn_handler)
        try:
            await worker.handle_message(
                _envelope("turn.start", _job(), message_id="start-handoff", run_id="run-1")
            )
            await worker.handle_message(
                _envelope(
                    "turn.steer",
                    {
                        "session_id": "session-1",
                        "text": "handoff steering",
                        "response_route_id": "route-handoff",
                        "message_id": "message-handoff",
                    },
                    message_id="steer-handoff",
                    run_id="run-1",
                )
            )
            release_turn.set()
            completion = await _wait_for_output(
                outputs,
                kind="runtime.turn.completed",
                run_id="run-1",
            )

            steer_reply = await _wait_for_reply(outputs, "steer-handoff")
            assert steer_reply["kind"] == "turn.steer.result"
            assert completion["payload"]["remaining_steering"] == [
                {
                    "text": "handoff steering",
                    "response_route_id": "route-handoff",
                    "message_id": "message-handoff",
                }
            ]
        finally:
            await worker.shutdown()

    asyncio.run(run())


def test_steering_after_closure_is_rejected_while_completion_is_in_flight() -> None:
    release_turn = asyncio.Event()
    completion_started = asyncio.Event()
    release_completion = asyncio.Event()

    async def fake_turn_handler(**_kwargs: Any) -> None:
        await release_turn.wait()

    async def run() -> None:
        outputs: list[dict[str, Any]] = []

        async def write_envelope(envelope: dict[str, Any]) -> None:
            if envelope["kind"] == "runtime.turn.completed":
                completion_started.set()
                await release_completion.wait()
            outputs.append(envelope)

        worker = RuntimeWorker(
            write_envelope=write_envelope,
            turn_handler=fake_turn_handler,
            initialize_storage=lambda: None,
            close_storage=lambda: None,
        )
        await worker.start()
        try:
            await worker.handle_message(
                _envelope("turn.start", _job(), message_id="start-closing", run_id="run-1")
            )
            release_turn.set()
            await asyncio.wait_for(completion_started.wait(), timeout=1)

            late_steer = asyncio.create_task(
                worker.handle_message(
                    _envelope(
                        "turn.steer",
                        {"session_id": "session-1", "text": "too late"},
                        message_id="steer-closing",
                        run_id="run-1",
                    )
                )
            )
            await asyncio.sleep(0)
            assert late_steer.done() is False
            release_completion.set()
            await late_steer

            result = await _wait_for_reply(outputs, "steer-closing")
            assert result["kind"] == "error"
            assert result["payload"]["code"] == "run_closing"
            assert not any(
                item["kind"] == "turn.steer.result" and item["reply_to"] == "steer-closing"
                for item in outputs
            )
        finally:
            release_completion.set()
            await worker.shutdown()

    asyncio.run(run())


def test_cancel_accepted_before_closure_produces_cancelled_completion() -> None:
    release_turn = asyncio.Event()

    async def fake_turn_handler(**_kwargs: Any) -> None:
        await release_turn.wait()

    async def run() -> None:
        outputs: list[dict[str, Any]] = []
        worker = await _started_worker(outputs, turn_handler=fake_turn_handler)
        try:
            await worker.handle_message(
                _envelope("turn.start", _job(), message_id="start-cancel-race", run_id="run-1")
            )
            await asyncio.sleep(0)
            await worker.handle_message(
                _envelope(
                    "turn.cancel",
                    {"session_id": "session-1"},
                    message_id="cancel-before-closing",
                    run_id="run-1",
                )
            )
            assert worker._active_runs["run-1"].handle.cancelled is True
            release_turn.set()

            completion = await _wait_for_output(
                outputs,
                kind="runtime.turn.completed",
                run_id="run-1",
            )
            cancel = await _wait_for_reply(outputs, "cancel-before-closing")
            assert cancel["kind"] == "turn.cancel.result"
            assert cancel["payload"]["cancelled"] is True
            assert completion["payload"]["status"] == "cancelled"
        finally:
            release_turn.set()
            await worker.shutdown()

    asyncio.run(run())


def test_cancel_after_closure_is_rejected_while_completion_is_in_flight() -> None:
    release_turn = asyncio.Event()
    completion_started = asyncio.Event()
    release_completion = asyncio.Event()

    async def fake_turn_handler(**_kwargs: Any) -> None:
        await release_turn.wait()

    async def run() -> None:
        outputs: list[dict[str, Any]] = []

        async def write_envelope(envelope: dict[str, Any]) -> None:
            if envelope["kind"] == "runtime.turn.completed":
                completion_started.set()
                await release_completion.wait()
            outputs.append(envelope)

        worker = RuntimeWorker(
            write_envelope=write_envelope,
            turn_handler=fake_turn_handler,
            initialize_storage=lambda: None,
            close_storage=lambda: None,
        )
        await worker.start()
        try:
            await worker.handle_message(
                _envelope("turn.start", _job(), message_id="start-cancel-closing", run_id="run-1")
            )
            release_turn.set()
            await asyncio.wait_for(completion_started.wait(), timeout=1)

            late_cancel = asyncio.create_task(
                worker.handle_message(
                    _envelope(
                        "turn.cancel",
                        {"session_id": "session-1"},
                        message_id="cancel-closing",
                        run_id="run-1",
                    )
                )
            )
            await asyncio.sleep(0)
            assert late_cancel.done() is False
            release_completion.set()
            await late_cancel

            completion = await _wait_for_output(
                outputs,
                kind="runtime.turn.completed",
                run_id="run-1",
            )
            result = await _wait_for_reply(outputs, "cancel-closing")
            assert completion["payload"]["status"] == "completed"
            assert result["kind"] == "error"
            assert result["payload"]["code"] == "run_closing"
            assert not any(
                item["kind"] == "turn.cancel.result" and item["reply_to"] == "cancel-closing"
                for item in outputs
            )
            while worker._active_runs:
                await asyncio.sleep(0)
            await worker.handle_message(
                _envelope(
                    "turn.cancel",
                    {"session_id": "session-1"},
                    message_id="cancel-after-completed",
                    run_id="run-1",
                )
            )
            after_completed = await _wait_for_reply(outputs, "cancel-after-completed")
            assert after_completed["kind"] == "error"
            assert after_completed["payload"]["code"] == "run_closing"
        finally:
            release_completion.set()
            await worker.shutdown()

    asyncio.run(run())


def test_distinct_sessions_run_concurrently() -> None:
    started: set[str] = set()
    both_started = asyncio.Event()
    release = asyncio.Event()

    async def fake_turn_handler(job: AgentJob, **_kwargs: Any) -> None:
        started.add(job.session_id)
        if len(started) == 2:
            both_started.set()
        await release.wait()

    async def run() -> None:
        outputs: list[dict[str, Any]] = []
        worker = await _started_worker(outputs, turn_handler=fake_turn_handler)
        try:
            await worker.handle_message(
                _envelope(
                    "turn.start",
                    _job(job_id="run-a", session_id="session-a"),
                    message_id="start-a",
                    run_id="run-a",
                )
            )
            await worker.handle_message(
                _envelope(
                    "turn.start",
                    _job(job_id="run-b", session_id="session-b"),
                    message_id="start-b",
                    run_id="run-b",
                )
            )
            await asyncio.wait_for(both_started.wait(), timeout=1)
            await worker.handle_message(_envelope("health", message_id="health-concurrent"))
            health = next(item for item in outputs if item["reply_to"] == "health-concurrent")
            assert health["payload"]["active_run_count"] == 2
            release.set()
            await _wait_for_output(outputs, kind="runtime.turn.completed", run_id="run-a")
            await _wait_for_output(outputs, kind="runtime.turn.completed", run_id="run-b")
        finally:
            await worker.shutdown()

    asyncio.run(run())


def test_duplicate_run_id_never_emits_duplicate_completion() -> None:
    release = asyncio.Event()

    async def fake_turn_handler(**_kwargs: Any) -> None:
        await release.wait()

    async def run() -> None:
        outputs: list[dict[str, Any]] = []
        worker = await _started_worker(outputs, turn_handler=fake_turn_handler)
        try:
            start = _envelope("turn.start", _job(), message_id="start-original", run_id="run-1")
            await worker.handle_message(start)
            duplicate = _envelope("turn.start", _job(), message_id="start-duplicate", run_id="run-1")
            await worker.handle_message(duplicate)
            release.set()
            await _wait_for_output(outputs, kind="runtime.turn.completed", run_id="run-1")
            await worker.handle_message(
                _envelope("turn.start", _job(), message_id="start-after-complete", run_id="run-1")
            )

            completions = [
                item
                for item in outputs
                if item["kind"] == "runtime.turn.completed" and item["run_id"] == "run-1"
            ]
            duplicate_errors = [
                item
                for item in outputs
                if item["kind"] == "error" and item["payload"]["code"] == "duplicate_run"
            ]
            assert len(completions) == 1
            assert {item["reply_to"] for item in duplicate_errors} == {
                "start-duplicate",
                "start-after-complete",
            }
        finally:
            await worker.shutdown()

    asyncio.run(run())


def test_surrogate_turn_exception_emits_one_safe_error_completion() -> None:
    async def failing_turn(**_kwargs: Any) -> None:
        raise RuntimeError("\ud800")

    async def run() -> None:
        outputs: list[dict[str, Any]] = []
        worker = await _started_worker(outputs, turn_handler=failing_turn)
        try:
            await worker.handle_message(
                _envelope("turn.start", _job(), message_id="start-error", run_id="run-1")
            )
            while worker._active_runs:
                await asyncio.sleep(0)
            await worker.handle_message(_envelope("health", message_id="health-after-turn-error"))

            completions = [
                item
                for item in outputs
                if item["kind"] == "runtime.turn.completed" and item["run_id"] == "run-1"
            ]
            assert len(completions) == 1
            assert completions[0]["payload"] == {
                "session_id": "session-1",
                "status": "error",
                "error": "RuntimeError",
                "remaining_steering": [],
            }
            assert "\\ud800" not in json.dumps(completions[0], ensure_ascii=True)
            assert outputs[-1]["kind"] == "health.result"
            assert outputs[-1]["payload"]["ready"] is True
        finally:
            await worker.shutdown()

    asyncio.run(run())


def test_completion_guard_marks_emitted_only_after_successful_write() -> None:
    release_turn = asyncio.Event()
    completion_attempts = 0

    async def waiting_turn(**_kwargs: Any) -> None:
        await release_turn.wait()

    async def run() -> None:
        nonlocal completion_attempts
        outputs: list[dict[str, Any]] = []

        async def fail_first_completion(envelope: dict[str, Any]) -> None:
            nonlocal completion_attempts
            if envelope["kind"] == "runtime.turn.completed":
                completion_attempts += 1
                if completion_attempts == 1:
                    raise RuntimeError("transient completion write failure")
            outputs.append(envelope)

        worker = RuntimeWorker(
            write_envelope=fail_first_completion,
            turn_handler=waiting_turn,
            initialize_storage=lambda: None,
            close_storage=lambda: None,
        )
        await worker.start()
        try:
            await worker.handle_message(
                _envelope("turn.start", _job(), message_id="start-retry", run_id="run-1")
            )
            await asyncio.sleep(0)
            current = worker._active_runs["run-1"]
            with pytest.raises(RuntimeError, match="transient completion write failure"):
                await worker._emit_completion_once(
                    current,
                    status="error",
                    error_message="safe error",
                    remaining_steering=[],
                )
            await worker._emit_completion_once(
                current,
                status="error",
                error_message="safe error",
                remaining_steering=[],
            )
            release_turn.set()
            while worker._active_runs:
                await asyncio.sleep(0)

            completions = [item for item in outputs if item["kind"] == "runtime.turn.completed"]
            assert completion_attempts == 2
            assert len(completions) == 1
            assert completions[0]["payload"]["status"] == "error"
        finally:
            release_turn.set()
            await worker.shutdown()

    asyncio.run(run())


def test_maintenance_and_dashboard_dispatch_are_explicit_allowlists() -> None:
    maintenance_calls: list[tuple[str, dict[str, Any]]] = []

    async def refresh(params: dict[str, Any]) -> dict[str, Any]:
        maintenance_calls.append(("refresh", params))
        return {"source": "cache"}

    def sync(params: dict[str, Any]) -> dict[str, Any]:
        maintenance_calls.append(("sync", params))
        return {"uploaded": False, "skipped_reason": "disabled"}

    async def sessions(params: dict[str, Any]) -> dict[str, Any]:
        return {"limit": params["limit"], "items": []}

    async def run() -> None:
        outputs: list[dict[str, Any]] = []
        worker = await _started_worker(
            outputs,
            maintenance_handlers={
                "mabang_erp_cookie_refresh": refresh,
                "data_server_sync": sync,
            },
            dashboard_handlers={"sessions.list": sessions},
        )
        try:
            await worker.handle_message(
                _envelope(
                    "maintenance.run",
                    {"operation": "mabang_erp_cookie_refresh", "params": {"force": True}},
                    message_id="maintenance-refresh",
                )
            )
            await worker.handle_message(
                _envelope(
                    "maintenance.run",
                    {"operation": "data_server_sync", "params": {"gateway_id": "gateway-1"}},
                    message_id="maintenance-sync",
                )
            )
            await worker.handle_message(
                _envelope(
                    "dashboard.query",
                    {"operation": "sessions.list", "params": {"limit": 10}},
                    message_id="dashboard-list",
                )
            )
            await worker.handle_message(
                _envelope(
                    "dashboard.query",
                    {"operation": "builtins.eval", "params": {"code": "1 + 1"}},
                    message_id="dashboard-rejected",
                )
            )

            assert maintenance_calls == [
                ("refresh", {"force": True}),
                ("sync", {"gateway_id": "gateway-1"}),
            ]
            dashboard = next(item for item in outputs if item["reply_to"] == "dashboard-list")
            rejected = next(item for item in outputs if item["reply_to"] == "dashboard-rejected")
            assert dashboard["payload"] == {"result": {"limit": 10, "items": []}}
            assert rejected["kind"] == "error"
            assert rejected["payload"]["code"] == "unsupported_operation"
        finally:
            await worker.shutdown()

    asyncio.run(run())


@pytest.mark.parametrize("invalid_value", [float("nan"), float("inf"), float("-inf")])
def test_non_finite_handler_result_returns_error_and_worker_stays_ready(
    invalid_value: float,
) -> None:
    async def non_finite(_params: dict[str, Any]) -> dict[str, float]:
        return {"value": invalid_value}

    async def run() -> None:
        outputs: list[dict[str, Any]] = []
        worker = await _started_worker(
            outputs,
            dashboard_handlers={"metrics.invalid": non_finite},
        )
        try:
            await worker.handle_message(
                _envelope(
                    "dashboard.query",
                    {"operation": "metrics.invalid", "params": {}},
                    message_id="dashboard-nan",
                )
            )
            await worker.handle_message(_envelope("health", message_id="health-after-nan"))

            assert outputs[0]["kind"] == "error"
            assert outputs[0]["reply_to"] == "dashboard-nan"
            assert outputs[0]["payload"]["code"] == "invalid_result"
            assert outputs[1]["kind"] == "health.result"
            assert outputs[1]["payload"]["ready"] is True
        finally:
            await worker.shutdown()

    asyncio.run(run())


def test_surrogate_in_incoming_envelope_returns_safe_correlated_error() -> None:
    async def run() -> None:
        outputs: list[dict[str, Any]] = []
        worker = await _started_worker(outputs)
        try:
            await worker.handle_line(
                '{"protocol_version":"1","message_id":"surrogate-input",'
                '"reply_to":null,"run_id":"surrogate-run","seq":0,'
                '"kind":"\\ud800","payload":{"nested":["\\udfff"]}}'
            )
            await worker.handle_message(_envelope("health", message_id="health-after-surrogate"))

            error = outputs[0]
            assert error["kind"] == "error"
            assert error["reply_to"] == "surrogate-input"
            assert error["run_id"] == "surrogate-run"
            assert error["payload"]["code"] == "invalid_envelope"
            assert error["payload"]["request_kind"] == ""
            assert "\\ud800" not in json.dumps(error, ensure_ascii=True)
            assert "\\udfff" not in json.dumps(error, ensure_ascii=True)
            assert outputs[1]["kind"] == "health.result"
            assert outputs[1]["payload"]["ready"] is True
        finally:
            await worker.shutdown()

    asyncio.run(run())


def test_surrogate_in_handler_result_returns_error_and_worker_stays_ready() -> None:
    async def unsafe_result(_params: dict[str, Any]) -> dict[str, Any]:
        return {"nested": ["safe", "\ud800"]}

    async def run() -> None:
        outputs: list[dict[str, Any]] = []
        worker = await _started_worker(
            outputs,
            dashboard_handlers={"metrics.surrogate": unsafe_result},
        )
        try:
            await worker.handle_message(
                _envelope(
                    "dashboard.query",
                    {"operation": "metrics.surrogate", "params": {}},
                    message_id="surrogate-result",
                )
            )
            await worker.handle_message(
                _envelope("health", message_id="health-after-surrogate-result")
            )

            error = outputs[0]
            assert error["kind"] == "error"
            assert error["reply_to"] == "surrogate-result"
            assert error["payload"]["code"] == "invalid_result"
            assert "\\ud800" not in json.dumps(error, ensure_ascii=True)
            assert outputs[1]["kind"] == "health.result"
            assert outputs[1]["payload"]["ready"] is True
        finally:
            await worker.shutdown()

    asyncio.run(run())


def test_serve_reads_health_while_sync_operation_is_in_flight() -> None:
    operation_started = threading.Event()
    release_operation = threading.Event()
    run_started = asyncio.Event()
    steering_received: list[dict[str, str]] = []

    def blocking_sync(_params: dict[str, Any]) -> dict[str, bool]:
        operation_started.set()
        if not release_operation.wait(timeout=2):
            raise RuntimeError("test operation release timed out")
        return {"finished": True}

    async def active_turn(job: AgentJob, *, run_handle: Any, **_kwargs: Any) -> None:
        _ = job
        run_started.set()
        while not run_handle.cancelled:
            steering_received.extend(run_handle.drain_steering())
            await asyncio.sleep(0)

    async def run() -> None:
        outputs: list[dict[str, Any]] = []
        worker = await _started_worker(
            outputs,
            turn_handler=active_turn,
            maintenance_handlers={"data_server_sync": blocking_sync},
        )

        async def lines():
            yield json.dumps(
                _envelope(
                    "turn.start",
                    _job(job_id="serve-run", session_id="serve-session"),
                    message_id="serve-start",
                    run_id="serve-run",
                )
            )
            await asyncio.wait_for(run_started.wait(), timeout=1)
            yield json.dumps(
                _envelope(
                    "maintenance.run",
                    {"operation": "data_server_sync", "params": {}},
                    message_id="maintenance-blocking",
                )
            )
            yield json.dumps(
                _envelope(
                    "turn.steer",
                    {"session_id": "serve-session", "text": "adjust now"},
                    message_id="steer-during-maintenance",
                    run_id="serve-run",
                )
            )
            yield json.dumps(_envelope("health", message_id="health-during-maintenance"))
            yield json.dumps(
                _envelope(
                    "turn.cancel",
                    {"session_id": "serve-session"},
                    message_id="cancel-during-maintenance",
                    run_id="serve-run",
                )
            )
            yield json.dumps(
                _envelope("worker.shutdown", message_id="shutdown-during-maintenance")
            )

        serve_task = asyncio.create_task(worker.serve(lines()))
        try:
            assert await asyncio.to_thread(operation_started.wait, 1)
            health = await _wait_for_output(outputs, kind="health.result", timeout=0.25)
            steer = await _wait_for_reply(outputs, "steer-during-maintenance", timeout=0.25)
            cancel = await _wait_for_reply(outputs, "cancel-during-maintenance", timeout=0.25)
            shutdown = await _wait_for_reply(outputs, "shutdown-during-maintenance", timeout=0.25)
            assert health["reply_to"] == "health-during-maintenance"
            assert health["payload"]["ready"] is True
            assert steer["kind"] == "turn.steer.result"
            assert cancel["kind"] == "turn.cancel.result"
            assert shutdown["kind"] == "worker.shutdown.result"
            assert steering_received == [
                {"text": "adjust now", "response_route_id": "", "message_id": ""}
            ]
        finally:
            release_operation.set()
            await serve_task

    asyncio.run(run())


def test_shutdown_request_and_eof_reset_handlers() -> None:
    async def run() -> None:
        outputs: list[dict[str, Any]] = []
        worker = await _started_worker(outputs)
        await worker.handle_message(
            _envelope("worker.shutdown", message_id="shutdown-1")
        )
        assert worker.stop_requested is True
        assert outputs[-1]["kind"] == "worker.shutdown.result"
        assert outputs[-1]["reply_to"] == "shutdown-1"
        await worker.shutdown()
        with pytest.raises(RuntimeError, match="runtime emit handler not configured"):
            await send_emit_request(EmitRequest(session_id="session-1", emit_kind="final"))

        eof_outputs: list[dict[str, Any]] = []
        eof_worker = await _started_worker(eof_outputs)

        async def lines():
            yield json.dumps(_envelope("worker.hello", message_id="hello-eof")) + "\n"

        await eof_worker.serve(lines())
        assert eof_outputs[-1]["kind"] == "worker.hello.result"
        with pytest.raises(RuntimeError, match="runtime emit handler not configured"):
            await emit_final(session_id="session-1", content="after EOF")

    asyncio.run(run())


def test_eof_cancels_active_run_with_one_completion() -> None:
    run_started = asyncio.Event()
    provider_cancel_calls: list[str] = []

    async def active_turn(job: AgentJob, *, run_handle: Any, **_kwargs: Any) -> None:
        _ = job
        run_handle.set_provider_cancel_handle(lambda: provider_cancel_calls.append("cancel"))
        run_started.set()
        await run_handle.cancel_event.wait()

    async def run() -> None:
        outputs: list[dict[str, Any]] = []
        worker = await _started_worker(outputs, turn_handler=active_turn)

        async def lines():
            yield json.dumps(
                _envelope(
                    "turn.start",
                    _job(job_id="eof-run", session_id="eof-session"),
                    message_id="eof-start",
                    run_id="eof-run",
                )
            )
            await asyncio.wait_for(run_started.wait(), timeout=1)

        await worker.serve(lines())
        completions = [
            item
            for item in outputs
            if item["kind"] == "runtime.turn.completed" and item["run_id"] == "eof-run"
        ]
        assert len(completions) == 1
        assert completions[0]["reply_to"] == "eof-start"
        assert completions[0]["payload"] == {
            "session_id": "eof-session",
            "status": "cancelled",
        }
        assert provider_cancel_calls == ["cancel"]

    asyncio.run(run())


def test_stdio_stdout_contains_ndjson_only(tmp_path: Path) -> None:
    env = os.environ.copy()
    env["LXE_SQLITE_DB_PATH"] = str(tmp_path / "subprocess.sqlite3")
    env["LOCAL_LOGS_ENABLED"] = "0"
    env["PYTHONIOENCODING"] = "ascii"
    stdin = "\n".join(
        [
            json.dumps(_envelope("worker.hello", message_id="hello-subprocess")),
            json.dumps(_envelope("中文😀.请求", message_id="unicode-error")),
            (
                '{"protocol_version":"1","message_id":"nan-input","reply_to":null,'
                '"run_id":null,"seq":1,"kind":"health","payload":{"value":NaN}}'
            ),
            (
                '{"protocol_version":"1","message_id":"infinity-input","reply_to":null,'
                '"run_id":null,"seq":2,"kind":"health","payload":{"value":Infinity}}'
            ),
            json.dumps(_envelope("worker.shutdown", message_id="shutdown-subprocess")),
            "",
        ]
    )
    result = subprocess.run(
        [sys.executable, "-m", "agent_runtime.worker"],
        input=stdin,
        text=True,
        capture_output=True,
        env=env,
        cwd=Path(__file__).parents[1],
        timeout=10,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    stdout_lines = [line for line in result.stdout.splitlines() if line.strip()]
    parsed = [json.loads(line) for line in stdout_lines]
    assert [item["kind"] for item in parsed] == [
        "worker.hello.result",
        "error",
        "error",
        "error",
        "worker.shutdown.result",
    ]
    assert parsed[1]["payload"]["message"] == "unsupported request kind: 中文😀.请求"
    assert [item["payload"]["code"] for item in parsed[2:4]] == [
        "invalid_json",
        "invalid_json",
    ]
    assert all(item["protocol_version"] == "1" for item in parsed)
