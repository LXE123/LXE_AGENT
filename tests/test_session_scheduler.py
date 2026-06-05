from __future__ import annotations

import asyncio

from gateway.session_scheduler import RunHandle, SessionScheduler
from shared.agent_io import AgentJob


def _job(session_id: str, job_id: str) -> AgentJob:
    return AgentJob(
        job_id=job_id,
        session_id=session_id,
        session_key=f"key:{session_id}",
        card_id=f"card:{job_id}",
        user_id="user",
        conversation_id="chat",
        is_group=False,
        message_id="msg",
        user_input="hello",
    )


def test_scheduler_tracks_active_run_and_stop_request() -> None:
    async def _run() -> None:
        started = asyncio.Event()
        release = asyncio.Event()
        handles = []

        async def executor(job, handle) -> None:
            handles.append(handle)
            started.set()
            await release.wait()

        scheduler = SessionScheduler(executor=executor, max_concurrency=1)
        await scheduler.enqueue(_job("session-1", "job-1"))
        await asyncio.wait_for(started.wait(), timeout=1)

        active = scheduler.active_run("session-1")
        assert active is not None
        assert active.job_id == "job-1"
        assert active.card_id == "card:job-1"
        assert scheduler.has_inflight_work("session-1") is True

        assert scheduler.request_stop("session-1") is True
        assert active.cancel_event.is_set()
        assert active.thread_cancel_event.is_set()

        release.set()
        await asyncio.sleep(0)
        for _ in range(20):
            if scheduler.active_run("session-1") is None:
                break
            await asyncio.sleep(0.01)
        assert scheduler.active_run("session-1") is None
        assert scheduler.has_inflight_work("session-1") is False
        await scheduler.stop()

    asyncio.run(_run())


def test_scheduler_runs_one_job_per_session_at_a_time() -> None:
    async def _run() -> None:
        order: list[str] = []
        first_started = asyncio.Event()
        release_first = asyncio.Event()

        async def executor(job, _handle) -> None:
            order.append(job.job_id)
            if job.job_id == "job-1":
                first_started.set()
                await release_first.wait()

        scheduler = SessionScheduler(executor=executor, max_concurrency=2)
        await scheduler.enqueue(_job("session-1", "job-1"))
        await scheduler.enqueue(_job("session-1", "job-2"))
        await asyncio.wait_for(first_started.wait(), timeout=1)
        await asyncio.sleep(0.05)
        assert order == ["job-1"]

        release_first.set()
        for _ in range(20):
            if order == ["job-1", "job-2"]:
                break
            await asyncio.sleep(0.01)
        assert order == ["job-1", "job-2"]
        await scheduler.stop()

    asyncio.run(_run())


def test_run_handle_cancel_invokes_provider_and_tool_cancel_handles() -> None:
    provider_calls: list[str] = []
    tool_calls: list[str] = []
    handle = RunHandle(session_id="session-1", job_id="job-1")

    handle.set_provider_cancel_handle(lambda: provider_calls.append("provider"))
    handle.register_tool_run(
        "toolu-1",
        "exec",
        cancel_handle=lambda: tool_calls.append("tool"),
    )

    handle.request_cancel()

    assert handle.cancel_event.is_set()
    assert handle.thread_cancel_event.is_set()
    assert provider_calls == ["provider"]
    assert tool_calls == ["tool"]


def test_run_handle_tool_tracking_cleans_finished_tools() -> None:
    handle = RunHandle(session_id="session-1", job_id="job-1")

    handle.register_tool_run("toolu-1", "exec")
    assert sorted(handle.active_tools) == ["toolu-1"]

    handle.finish_tool_run("toolu-1")
    assert handle.active_tools == {}
