from __future__ import annotations

import asyncio
from types import SimpleNamespace

import gateway.session_router as router_mod
from gateway.models import InboundEvent
from gateway.session_router import SessionRouter
from shared.agent_sessions import AgentSessionStatus
from shared.permission_policy import BOT_ID_LXE_CLAW, BOT_ID_LXE_FBA_AGENT, USER_LYX, USER_ZQY

OPEN_ID_LYX = "ou_lyx_open_id"
OPEN_ID_ZQY = "ou_zqy_open_id"


class _FakeAdapter:
    platform = "feishu"
    connector_key = "agent"

    def __init__(self) -> None:
        self.outbound_requests = []

    async def handle_outbound(self, request) -> None:
        self.outbound_requests.append(request)


class _FakeRegistry:
    def __init__(self, adapter: _FakeAdapter) -> None:
        self.adapter = adapter

    def get(self, platform: str, connector_key: str):
        assert platform == "feishu"
        assert connector_key == "agent"
        return self.adapter


class _FakeScheduler:
    def __init__(self) -> None:
        self.jobs = []

    async def enqueue(self, job, *, front: bool = False) -> None:
        self.jobs.append((job, front))


def _event(*, user_id: str, union_id: str, app_id: str) -> InboundEvent:
    return InboundEvent(
        platform="feishu",
        connector_key="agent",
        event_type="agent_message",
        user_input="hello",
        user_id=user_id,
        conversation_id="chat-1",
        is_group=False,
        message_id="msg-1",
        sender_nick="sender",
        card_id="card-1",
        union_id=union_id,
        raw_data={
            "platform": "feishu",
            "connector_key": "agent",
            "app_id": app_id,
            "union_id": union_id,
        },
    )


def _router(adapter: _FakeAdapter, scheduler: _FakeScheduler) -> SessionRouter:
    router = SessionRouter(registry=_FakeRegistry(adapter))
    router.bind_scheduler(scheduler)
    return router


def test_router_denies_unknown_bot_without_enqueue(monkeypatch) -> None:
    adapter = _FakeAdapter()
    scheduler = _FakeScheduler()
    router = _router(adapter, scheduler)

    async def fake_create_card_context(_ctx) -> None:
        return None

    async def fail_db_call(*_args, **_kwargs):
        raise AssertionError("permission denied route should not touch agent session storage")

    monkeypatch.setattr(router_mod, "create_card_context", fake_create_card_context)
    monkeypatch.setattr(router_mod, "load_active_agent_session_by_user", fail_db_call)
    monkeypatch.setattr(router_mod, "create_agent_session", fail_db_call)

    decision = asyncio.run(
        router.route_message(_event(user_id=OPEN_ID_LYX, union_id=USER_LYX, app_id="cli_unknown"))
    )

    assert decision.route_kind == "permission_denied"
    assert scheduler.jobs == []
    assert len(adapter.outbound_requests) == 1
    assert "未授权" in adapter.outbound_requests[0].payload["markdown"]


def test_router_denies_user_without_agent_access(monkeypatch) -> None:
    adapter = _FakeAdapter()
    scheduler = _FakeScheduler()
    router = _router(adapter, scheduler)

    async def fake_create_card_context(_ctx) -> None:
        return None

    async def fail_db_call(*_args, **_kwargs):
        raise AssertionError("permission denied route should not touch agent session storage")

    monkeypatch.setattr(router_mod, "create_card_context", fake_create_card_context)
    monkeypatch.setattr(router_mod, "load_active_agent_session_by_user", fail_db_call)
    monkeypatch.setattr(router_mod, "create_agent_session", fail_db_call)

    decision = asyncio.run(
        router.route_message(_event(user_id=OPEN_ID_ZQY, union_id=USER_ZQY, app_id=BOT_ID_LXE_CLAW))
    )

    assert decision.route_kind == "permission_denied"
    assert scheduler.jobs == []
    assert len(adapter.outbound_requests) == 1
    assert "没有权限" in adapter.outbound_requests[0].payload["markdown"]


def test_router_does_not_fallback_to_open_id_for_user_access(monkeypatch) -> None:
    adapter = _FakeAdapter()
    scheduler = _FakeScheduler()
    router = _router(adapter, scheduler)

    async def fake_create_card_context(_ctx) -> None:
        return None

    async def fail_db_call(*_args, **_kwargs):
        raise AssertionError("permission denied route should not touch agent session storage")

    monkeypatch.setattr(router_mod, "create_card_context", fake_create_card_context)
    monkeypatch.setattr(router_mod, "load_active_agent_session_by_user", fail_db_call)
    monkeypatch.setattr(router_mod, "create_agent_session", fail_db_call)

    decision = asyncio.run(
        router.route_message(_event(user_id=USER_LYX, union_id="", app_id=BOT_ID_LXE_FBA_AGENT))
    )

    assert decision.route_kind == "permission_denied"
    assert scheduler.jobs == []
    assert len(adapter.outbound_requests) == 1
    assert "没有权限" in adapter.outbound_requests[0].payload["markdown"]


def test_router_allows_authorized_user_and_bot(monkeypatch) -> None:
    adapter = _FakeAdapter()
    scheduler = _FakeScheduler()
    router = _router(adapter, scheduler)
    calls = {"created": 0}

    async def fake_create_card_context(_ctx) -> None:
        return None

    async def fake_load_session(*_args, **_kwargs):
        return None

    async def fake_create_agent_session(**kwargs):
        calls["created"] += 1
        return SimpleNamespace(
            session_id="session-1",
            platform=kwargs["platform"],
            connector_key=kwargs["connector_key"],
            owner_user_id=kwargs["owner_user_id"],
            conversation_id=kwargs["conversation_id"],
            conversation_type=kwargs["conversation_type"],
            sender_nick=kwargs["sender_nick"],
            status=AgentSessionStatus.WAITING_USER_INPUT,
            state_data=kwargs["state_data"],
        )

    async def fake_pop_pending_events(_session_id: str):
        return []

    monkeypatch.setattr(router_mod, "create_card_context", fake_create_card_context)
    monkeypatch.setattr(router_mod, "load_active_agent_session_by_user", fake_load_session)
    monkeypatch.setattr(router_mod, "create_agent_session", fake_create_agent_session)
    monkeypatch.setattr(router_mod, "pop_agent_session_pending_events", fake_pop_pending_events)

    decision = asyncio.run(
        router.route_message(_event(user_id=OPEN_ID_ZQY, union_id=USER_ZQY, app_id=BOT_ID_LXE_FBA_AGENT))
    )

    assert decision.route_kind == "agent_message"
    assert calls["created"] == 1
    assert len(scheduler.jobs) == 1
    job, front = scheduler.jobs[0]
    assert not front
    assert job.session_id == "session-1"
    assert job.user_id == OPEN_ID_ZQY
    assert job.raw_data["app_id"] == BOT_ID_LXE_FBA_AGENT
    assert job.raw_data["union_id"] == USER_ZQY
    assert adapter.outbound_requests == []
