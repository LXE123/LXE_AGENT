from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from gateway import session_router as session_router_module
from gateway.channel_registry import ChannelRegistry
from gateway.session_router import SessionRouter
from gateway.session_scheduler import RunHandle, SessionScheduler
from gateway.steering_mode import (
    is_session_steering_enabled,
    reset_steering_mode_for_tests,
    set_session_steering,
    toggle_session_steering,
)
from shared.agent_io import AgentJob
from shared.platform.context import SessionContext


@pytest.fixture(autouse=True)
def _clean_steering():
    reset_steering_mode_for_tests()
    yield
    reset_steering_mode_for_tests()


# --- RunHandle steering queue -------------------------------------------------

def test_run_handle_push_and_drain_steering() -> None:
    handle = RunHandle(session_id="s1", job_id="j1")
    assert handle.drain_steering() == []
    handle.push_steering("first", response_route_id="r1", message_id="m1")
    handle.push_steering("  ")  # blank ignored
    handle.push_steering("second")
    drained = handle.drain_steering()
    assert [item["text"] for item in drained] == ["first", "second"]
    assert drained[0]["response_route_id"] == "r1"
    assert drained[0]["message_id"] == "m1"
    # drained queue is now empty
    assert handle.drain_steering() == []


# --- steering mode toggle -----------------------------------------------------

def test_toggle_steering_mode() -> None:
    assert is_session_steering_enabled("s1") is False
    assert toggle_session_steering("s1") is True
    assert is_session_steering_enabled("s1") is True
    assert toggle_session_steering("s1") is False
    assert is_session_steering_enabled("s1") is False


# --- loop injection at step boundary -----------------------------------------

def test_loop_injects_steering_as_user_message() -> None:
    from agent_runtime.loop import AgentLoop
    from agent_runtime.context_pipeline import make_user_message

    async def _run() -> None:
        loop = AgentLoop(
            session=SimpleNamespace(session_id="s1", source={}),
            state_data={},
            steering_drain=lambda: [{"text": "先查库存", "response_route_id": "r1", "message_id": "m1"}],
        )
        appended: list[dict] = []

        async def append_message(message, *, checkpoint_reason: str = "", **_) -> None:
            appended.append({"message": message, "reason": checkpoint_reason})

        turn_log = SimpleNamespace(session_id="s1", turn_id="t1")
        injected = await loop._inject_steering_messages(append_message, turn_log=turn_log)

        assert injected is True
        assert len(appended) == 1
        assert appended[0]["reason"] == "user_steering"
        assert appended[0]["message"] == make_user_message("先查库存")

    asyncio.run(_run())


def test_loop_injection_tolerates_plain_strings() -> None:
    from agent_runtime.loop import AgentLoop
    from agent_runtime.context_pipeline import make_user_message

    async def _run() -> None:
        loop = AgentLoop(
            session=SimpleNamespace(session_id="s1", source={}),
            state_data={},
            steering_drain=lambda: ["先查库存"],
        )
        appended: list[dict] = []

        async def append_message(message, *, checkpoint_reason: str = "", **_) -> None:
            appended.append(message)

        injected = await loop._inject_steering_messages(
            append_message, turn_log=SimpleNamespace(session_id="s1", turn_id="t1")
        )
        assert injected is True
        assert appended == [make_user_message("先查库存")]

    asyncio.run(_run())


def test_loop_injects_nothing_when_queue_empty() -> None:
    from agent_runtime.loop import AgentLoop

    async def _run() -> None:
        loop = AgentLoop(
            session=SimpleNamespace(session_id="s1", source={}),
            state_data={},
            steering_drain=lambda: [],
        )
        appended: list[dict] = []

        async def append_message(message, *, checkpoint_reason: str = "", **_) -> None:
            appended.append(message)

        injected = await loop._inject_steering_messages(
            append_message, turn_log=SimpleNamespace(session_id="s1", turn_id="t1")
        )
        assert injected is False
        assert appended == []

    asyncio.run(_run())


def test_loop_no_steering_drain_is_noop() -> None:
    from agent_runtime.loop import AgentLoop

    async def _run() -> None:
        loop = AgentLoop(
            session=SimpleNamespace(session_id="s1", source={}),
            state_data={},
            steering_drain=None,
        )
        called = False

        async def append_message(message, *, checkpoint_reason: str = "", **_) -> None:
            nonlocal called
            called = True

        await loop._inject_steering_messages(
            append_message, turn_log=SimpleNamespace(session_id="s1", turn_id="t1")
        )
        assert called is False

    asyncio.run(_run())


# --- router routing decision --------------------------------------------------

def _ctx(user_input: str, *, content_blocks=None) -> SessionContext:
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
        source={"platform": "feishu", "chat_id": "chat-1", "chat_type": "dm", "user_id": "user-1"},
        user_content_blocks=list(content_blocks or []),
    )


def _job(session_id: str, job_id: str) -> AgentJob:
    return AgentJob(
        job_id=job_id,
        session_id=session_id,
        session_key=f"key:{session_id}",
        response_route_id="r",
        user_id="u",
        conversation_id="c",
        is_group=False,
        message_id="m",
        user_input="hi",
    )


def _router_with_active_run(monkeypatch, feedback: list[str]):
    async def _make(release: asyncio.Event, started: asyncio.Event) -> tuple[SessionRouter, SessionScheduler]:
        async def executor(job, handle) -> None:
            started.set()
            await release.wait()

        scheduler = SessionScheduler(executor=executor, max_concurrency=1)
        router = SessionRouter(registry=ChannelRegistry())
        router.bind_scheduler(scheduler)

        async def fake_feedback(ctx, *, session_id: str, markdown: str) -> None:
            feedback.append(markdown)

        monkeypatch.setattr(router, "_send_control_feedback", fake_feedback)
        return router, scheduler

    return _make


def test_try_steer_injects_when_enabled_and_running(monkeypatch: pytest.MonkeyPatch) -> None:
    feedback: list[str] = []

    async def _run() -> None:
        release = asyncio.Event()
        started = asyncio.Event()
        router, scheduler = await _router_with_active_run(monkeypatch, feedback)(release, started)

        await scheduler.enqueue(_job("s1", "j1"))
        await asyncio.wait_for(started.wait(), timeout=1)
        set_session_steering("s1", True)

        steered = await router._try_steer_active_run(session_id="s1", ctx=_ctx("先查库存"))
        assert steered is True

        handle = scheduler.active_run("s1")
        drained = handle.drain_steering()
        assert [item["text"] for item in drained] == ["先查库存"]
        assert drained[0]["response_route_id"] == "route-1"
        assert feedback and "已插入当前任务" in feedback[0]

        release.set()
        await scheduler.stop()

    asyncio.run(_run())


def test_try_steer_falls_back_when_mode_off(monkeypatch: pytest.MonkeyPatch) -> None:
    feedback: list[str] = []

    async def _run() -> None:
        release = asyncio.Event()
        started = asyncio.Event()
        router, scheduler = await _router_with_active_run(monkeypatch, feedback)(release, started)

        await scheduler.enqueue(_job("s1", "j1"))
        await asyncio.wait_for(started.wait(), timeout=1)
        # steering mode NOT enabled

        steered = await router._try_steer_active_run(session_id="s1", ctx=_ctx("先查库存"))
        assert steered is False
        assert feedback == []

        release.set()
        await scheduler.stop()

    asyncio.run(_run())


def test_try_steer_falls_back_when_no_active_run(monkeypatch: pytest.MonkeyPatch) -> None:
    async def _run() -> None:
        scheduler = SessionScheduler(executor=lambda job, handle: None, max_concurrency=1)
        router = SessionRouter(registry=ChannelRegistry())
        router.bind_scheduler(scheduler)
        set_session_steering("s1", True)

        steered = await router._try_steer_active_run(session_id="s1", ctx=_ctx("先查库存"))
        assert steered is False

    asyncio.run(_run())


def test_try_steer_falls_back_with_attachments(monkeypatch: pytest.MonkeyPatch) -> None:
    feedback: list[str] = []

    async def _run() -> None:
        release = asyncio.Event()
        started = asyncio.Event()
        router, scheduler = await _router_with_active_run(monkeypatch, feedback)(release, started)

        await scheduler.enqueue(_job("s1", "j1"))
        await asyncio.wait_for(started.wait(), timeout=1)
        set_session_steering("s1", True)

        ctx = _ctx("看看这个", content_blocks=[{"type": "image", "data": "x"}])
        steered = await router._try_steer_active_run(session_id="s1", ctx=ctx)
        assert steered is False  # attachments must go through normal enqueue

        release.set()
        await scheduler.stop()

    asyncio.run(_run())


def test_handle_steer_toggles_and_reports(monkeypatch: pytest.MonkeyPatch) -> None:
    feedback: list[str] = []

    async def _run() -> None:
        scheduler = SessionScheduler(executor=lambda job, handle: None, max_concurrency=1)
        router = SessionRouter(registry=ChannelRegistry())
        router.bind_scheduler(scheduler)

        async def fake_feedback(ctx, *, session_id: str, markdown: str) -> None:
            feedback.append(markdown)

        monkeypatch.setattr(router, "_send_control_feedback", fake_feedback)
        session = SimpleNamespace(session_id="s1")

        await router._handle_steer(session=session, ctx=_ctx("/steer"))
        assert is_session_steering_enabled("s1") is True
        assert "已开启实时插话模式" in feedback[0]

        await router._handle_steer(session=session, ctx=_ctx("/steer"))
        assert is_session_steering_enabled("s1") is False
        assert "已关闭实时插话模式" in feedback[1]

    asyncio.run(_run())


# --- turn extension: steering during the only/last LLM call -------------------

def test_single_step_turn_extends_when_steered_mid_call(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    """回归: turn 只有一次 LLM 调用时, 调用期间的插话必须在同一 turn 内被处理."""
    import agent_runtime.loop as loop_mod
    from agent_runtime.loop import AgentLoop
    from agent_runtime.tool_registry import UnifiedToolRegistry
    from agent_runtime.context_pipeline import load_context_messages
    from agent_runtime.types import TurnInput
    from agent_runtime.llm_adapter import LLMResponse

    config_path = tmp_path / "mcp.yaml"
    config_path.write_text("mcpServers: {}\n", encoding="utf-8")
    monkeypatch.setenv("LXE_MCP_CONFIG_PATH", str(config_path))

    handle = RunHandle(session_id="session-1", job_id="j1")
    llm_calls: list[int] = []

    async def fake_chat_with_tools_streaming(**_kwargs) -> LLMResponse:
        llm_calls.append(1)
        if len(llm_calls) == 1:
            # 第一次调用期间用户插话
            handle.push_steering("不对，先查库存")
            return LLMResponse(
                text="第一段回答",
                public_text="第一段回答",
                assistant_content=[{"type": "text", "text": "第一段回答"}],
            )
        return LLMResponse(
            text="好的，已改为先查库存",
            public_text="好的，已改为先查库存",
            assistant_content=[{"type": "text", "text": "好的，已改为先查库存"}],
        )

    monkeypatch.setattr(loop_mod, "chat_with_tools_streaming", fake_chat_with_tools_streaming)

    agent = AgentLoop(
        session=SimpleNamespace(
            session_id="session-1",
            owner_user_id="user-1",
            state_data={},
            source={"platform": "feishu"},
            conversation_type="1",
        ),
        state_data={},
        steering_drain=handle.drain_steering,
    )
    agent.tool_registry = UnifiedToolRegistry()

    outcome = asyncio.run(
        agent.run(
            TurnInput(
                user_input="请处理",
                session_id="session-1",
                user_id="user-1",
                available_skills=[],
            )
        )
    )

    assert outcome.status == "done"
    assert len(llm_calls) == 2  # turn 被延续, 没有提前结束
    messages = load_context_messages(outcome.state_data_patch)
    assert messages == [
        {"role": "user", "content": "请处理"},
        {"role": "assistant", "content": [{"type": "text", "text": "第一段回答"}]},
        {"role": "user", "content": "不对，先查库存"},
        {"role": "assistant", "content": [{"type": "text", "text": "好的，已改为先查库存"}]},
    ]
    assert outcome.reply == "好的，已改为先查库存"


# --- scheduler fallback: leftover steering requeued ---------------------------

def test_leftover_steering_requeued_as_new_turn() -> None:
    async def _run() -> None:
        executed: list[AgentJob] = []
        release_first = asyncio.Event()
        started = asyncio.Event()

        async def executor(job, handle) -> None:
            executed.append(job)
            if len(executed) == 1:
                started.set()
                await release_first.wait()
                # turn 结束前未消费插话(模拟最后一次 LLM 调用期间的插话)

        scheduler = SessionScheduler(executor=executor, max_concurrency=1)
        await scheduler.enqueue(_job("s1", "j1"))
        await asyncio.wait_for(started.wait(), timeout=1)

        handle = scheduler.active_run("s1")
        handle.push_steering("先查库存", response_route_id="route-2", message_id="m2")
        release_first.set()

        for _ in range(50):
            if len(executed) >= 2:
                break
            await asyncio.sleep(0.01)

        assert len(executed) == 2
        requeued = executed[1]
        assert requeued.user_input == "先查库存"
        assert requeued.job_kind == "turn"
        assert requeued.response_route_id == "route-2"
        assert requeued.message_id == "m2"
        assert requeued.session_id == "s1"
        await scheduler.stop()

    asyncio.run(_run())


def test_leftover_steering_dropped_after_cancelled_run() -> None:
    async def _run() -> None:
        executed: list[AgentJob] = []
        release = asyncio.Event()
        started = asyncio.Event()

        async def executor(job, handle) -> None:
            executed.append(job)
            started.set()
            await release.wait()

        scheduler = SessionScheduler(executor=executor, max_concurrency=1)
        await scheduler.enqueue(_job("s1", "j1"))
        await asyncio.wait_for(started.wait(), timeout=1)

        handle = scheduler.active_run("s1")
        handle.push_steering("这条应该被丢弃")
        scheduler.request_stop("s1")  # /stop 语义: 剩余插话不重入队
        release.set()

        await asyncio.sleep(0.2)
        assert len(executed) == 1
        assert not scheduler.has_inflight_work("s1")
        await scheduler.stop()

    asyncio.run(_run())
