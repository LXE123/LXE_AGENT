from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from gateway import heartbeat_wake as heartbeat_wake_module
from gateway import session_router as session_router_module
from gateway.autonomy_suspension import (
    is_session_autonomy_suspended,
    reset_autonomy_suspension_for_tests,
    resume_session_autonomy,
    suspend_session_autonomy,
)
from gateway.channel_registry import ChannelRegistry
from gateway.heartbeat_wake import HeartbeatWakeManager
from gateway.session_router import SessionRouter
from gateway.session_scheduler import SessionScheduler
from shared.agent_io import AgentJob
from shared.platform.context import SessionContext


@pytest.fixture(autouse=True)
def _clean_suspension_state():
    reset_autonomy_suspension_for_tests()
    yield
    reset_autonomy_suspension_for_tests()


def _job(session_id: str, job_id: str) -> AgentJob:
    return AgentJob(
        job_id=job_id,
        session_id=session_id,
        session_key=f"key:{session_id}",
        response_route_id=f"route:{job_id}",
        user_id="user",
        conversation_id="chat",
        is_group=False,
        message_id="msg",
        user_input="hello",
    )


def test_suspension_flag_lifecycle() -> None:
    assert is_session_autonomy_suspended("s1") is False
    suspend_session_autonomy("s1")
    assert is_session_autonomy_suspended("s1") is True
    assert resume_session_autonomy("s1") is True
    assert is_session_autonomy_suspended("s1") is False
    assert resume_session_autonomy("s1") is False


def test_scheduler_clear_pending_drops_queued_jobs() -> None:
    async def _run() -> None:
        started = asyncio.Event()
        release = asyncio.Event()

        async def executor(job, handle) -> None:
            started.set()
            await release.wait()

        scheduler = SessionScheduler(executor=executor, max_concurrency=1)
        await scheduler.enqueue(_job("session-1", "job-1"))
        await asyncio.wait_for(started.wait(), timeout=1)
        await scheduler.enqueue(_job("session-1", "job-2"))
        await scheduler.enqueue(_job("session-1", "job-3"))

        assert scheduler.clear_pending("session-1") == 2
        assert scheduler.has_inflight_work("session-1") is True  # active run remains

        assert scheduler.request_stop("session-1") is True
        release.set()
        for _ in range(20):
            if scheduler.active_run("session-1") is None:
                break
            await asyncio.sleep(0.01)
        assert scheduler.has_inflight_work("session-1") is False
        await scheduler.stop()

    asyncio.run(_run())


def test_scheduler_clear_pending_empty_session() -> None:
    async def _run() -> None:
        scheduler = SessionScheduler(executor=lambda job, handle: None, max_concurrency=1)
        assert scheduler.clear_pending("missing") == 0
        assert scheduler.clear_pending("") == 0

    asyncio.run(_run())


class _RecordingScheduler:
    def __init__(self) -> None:
        self.enqueued: list[AgentJob] = []

    def has_inflight_work(self, session_id: str) -> bool:
        return False

    async def enqueue(self, job: AgentJob, *, front: bool = False) -> None:
        self.enqueued.append(job)


_FAKE_SOURCE = {
    "platform": "feishu",
    "chat_id": "chat-1",
    "chat_type": "dm",
    "user_id": "user-1",
}


def test_heartbeat_wake_dropped_while_suspended(monkeypatch: pytest.MonkeyPatch) -> None:
    async def _run() -> None:
        scheduler = _RecordingScheduler()
        manager = HeartbeatWakeManager(scheduler=scheduler)  # type: ignore[arg-type]
        pending_checked: list[str] = []

        async def fake_has_pending(session_id: str) -> bool:
            pending_checked.append(session_id)
            return True

        async def fake_load_session(session_id: str):
            return SimpleNamespace(session_id=session_id, source=dict(_FAKE_SOURCE))

        monkeypatch.setattr(heartbeat_wake_module, "has_agent_session_pending_events", fake_has_pending)
        monkeypatch.setattr(heartbeat_wake_module, "load_agent_session_record", fake_load_session)

        suspend_session_autonomy("session-1")
        await manager.request_now(session_id="session-1", reason="exec-event")
        await asyncio.sleep(0.5)

        assert scheduler.enqueued == []
        # 挂起时直接丢弃，连 pending 检查都不需要
        assert pending_checked == []

        resume_session_autonomy("session-1")
        await manager.request_now(session_id="session-1", reason="exec-event")
        await asyncio.sleep(0.5)

        assert len(scheduler.enqueued) == 1
        assert scheduler.enqueued[0].job_kind == "heartbeat"
        await manager.stop()

    asyncio.run(_run())


def _session_context(user_input: str) -> SessionContext:
    return SessionContext(
        platform="feishu",
        session_key="feishu:dm:chat-1:user-1",
        response_route_id="route-1",
        user_id="user-1",
        conversation_id="chat-1",
        is_group=False,
        message_id="msg-1",
        user_input=user_input,
        sender_nick="tester",
        source=dict(_FAKE_SOURCE),
    )


def test_handle_stop_suspends_and_appends_stop_event(monkeypatch: pytest.MonkeyPatch) -> None:
    async def _run() -> None:
        started = asyncio.Event()
        release = asyncio.Event()

        async def executor(job, handle) -> None:
            started.set()
            await release.wait()

        scheduler = SessionScheduler(executor=executor, max_concurrency=1)
        await scheduler.enqueue(_job("session-1", "job-1"))
        await asyncio.wait_for(started.wait(), timeout=1)

        router = SessionRouter(registry=ChannelRegistry())
        router.bind_scheduler(scheduler)

        appended_events: list[tuple[str, dict]] = []
        feedback: list[str] = []

        async def fake_append_event(session_id: str, event: dict):
            appended_events.append((session_id, dict(event or {})))
            return SimpleNamespace(session_id=session_id)

        async def fake_feedback(ctx, *, session_id: str, markdown: str) -> None:
            feedback.append(markdown)

        monkeypatch.setattr(session_router_module, "append_agent_session_pending_event", fake_append_event)
        monkeypatch.setattr(router, "_send_control_feedback", fake_feedback)

        session = SimpleNamespace(session_id="session-1", source=dict(_FAKE_SOURCE))
        await router._handle_stop(session=session, ctx=_session_context("/stop"))

        assert is_session_autonomy_suspended("session-1") is True
        assert len(appended_events) == 1
        event_session_id, event = appended_events[0]
        assert event_session_id == "session-1"
        assert "叫停" in event["text"]
        assert event["job_id"].startswith("user-stop-")
        assert feedback and "暂停自动继续" in feedback[0]

        release.set()
        await scheduler.stop()

    asyncio.run(_run())


def test_handle_stop_without_active_run_still_suspends(monkeypatch: pytest.MonkeyPatch) -> None:
    async def _run() -> None:
        scheduler = SessionScheduler(executor=lambda job, handle: None, max_concurrency=1)
        router = SessionRouter(registry=ChannelRegistry())
        router.bind_scheduler(scheduler)

        appended_events: list[dict] = []
        feedback: list[str] = []

        async def fake_append_event(session_id: str, event: dict):
            appended_events.append(dict(event or {}))
            return SimpleNamespace(session_id=session_id)

        async def fake_feedback(ctx, *, session_id: str, markdown: str) -> None:
            feedback.append(markdown)

        monkeypatch.setattr(session_router_module, "append_agent_session_pending_event", fake_append_event)
        monkeypatch.setattr(router, "_send_control_feedback", fake_feedback)

        session = SimpleNamespace(session_id="session-2", source=dict(_FAKE_SOURCE))
        await router._handle_stop(session=session, ctx=_session_context("/stop"))

        # 没有正在执行的 turn：不写叫停事件，但仍挂起自主性
        assert is_session_autonomy_suspended("session-2") is True
        assert appended_events == []
        assert feedback and "暂停自动继续" in feedback[0]

        await scheduler.stop()

    asyncio.run(_run())
