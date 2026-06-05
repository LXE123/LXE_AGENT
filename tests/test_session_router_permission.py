from __future__ import annotations

import asyncio
from types import SimpleNamespace

import gateway.session_router as router_mod
from gateway.models import InboundEvent
from gateway.session_router import SessionRouter
from shared.agent_sessions import AgentSessionStatus
from shared.permission_policy import BOT_ID_LXE_CLAW, BOT_ID_LXE_FBA_AGENT, USER_LYX, USER_ZGL

OPEN_ID_LYX = "ou_lyx_open_id"
OPEN_ID_ZGL = "ou_zgl_open_id"


class _FakeAdapter:
    platform = "feishu"

    def __init__(self) -> None:
        self.outbound_requests = []

    async def handle_outbound(self, request) -> None:
        self.outbound_requests.append(request)


class _FakeRegistry:
    def __init__(self, adapter: _FakeAdapter) -> None:
        self.adapter = adapter

    def get(self, platform: str):
        assert platform == "feishu"
        return self.adapter


class _FakeScheduler:
    def __init__(self) -> None:
        self.jobs = []
        self.stopped_sessions = set()
        self.inflight_sessions = set()

    async def enqueue(self, job, *, front: bool = False) -> None:
        self.jobs.append((job, front))

    def request_stop(self, session_id: str) -> bool:
        safe_session_id = str(session_id or "").strip()
        if safe_session_id not in self.inflight_sessions:
            return False
        self.stopped_sessions.add(safe_session_id)
        return True

    def has_inflight_work(self, session_id: str) -> bool:
        return str(session_id or "").strip() in self.inflight_sessions


def _event(*, user_id: str, union_id: str, app_id: str) -> InboundEvent:
    return InboundEvent(
        platform="feishu",
        event_type="agent_message",
        user_input="hello",
        user_id=user_id,
        conversation_id="chat-1",
        is_group=False,
        message_id="msg-1",
        sender_nick="sender",
        card_id="card-1",
        union_id=union_id,
        source={
            "platform": "feishu",
            "chat_id": "chat-1",
            "chat_type": "p2p",
            "user_id": user_id,
            "user_id_alt": union_id,
            "user_name": "sender",
        },
        raw_data={
            "platform": "feishu",
            "app_id": app_id,
            "union_id": union_id,
        },
    )


def _router(adapter: _FakeAdapter, scheduler: _FakeScheduler) -> SessionRouter:
    router = SessionRouter(registry=_FakeRegistry(adapter))
    router.bind_scheduler(scheduler)
    router._bindings = SimpleNamespace(
        get=lambda _session_key: None,
        get_or_create=lambda _source: SimpleNamespace(session_id="session-1"),
        rotate=lambda _source: SimpleNamespace(session_id="session-rotated"),
    )
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
    monkeypatch.setattr(router_mod, "create_agent_session", fail_db_call)

    decision = asyncio.run(
        router.route_message(_event(user_id=OPEN_ID_ZGL, union_id=USER_ZGL, app_id=BOT_ID_LXE_CLAW))
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
            source=kwargs["source"],
            status=AgentSessionStatus.WAITING_USER_INPUT,
            state_data=kwargs["state_data"],
        )

    async def fake_pop_pending_events(_session_id: str):
        return []

    monkeypatch.setattr(router_mod, "create_card_context", fake_create_card_context)
    monkeypatch.setattr(router_mod, "load_agent_session", fake_load_session)
    monkeypatch.setattr(router_mod, "create_agent_session", fake_create_agent_session)
    monkeypatch.setattr(router_mod, "pop_agent_session_pending_events", fake_pop_pending_events)

    decision = asyncio.run(
        router.route_message(_event(user_id=OPEN_ID_ZGL, union_id=USER_ZGL, app_id=BOT_ID_LXE_FBA_AGENT))
    )

    assert decision.route_kind == "agent_message"
    assert calls["created"] == 1
    assert len(scheduler.jobs) == 1
    job, front = scheduler.jobs[0]
    assert not front
    assert job.session_id == "session-1"
    assert job.session_key == f"agent:main:feishu:dm:chat-1"
    assert job.card_id == "card-1"
    assert job.user_id == USER_ZGL
    assert job.raw_data["app_id"] == BOT_ID_LXE_FBA_AGENT
    assert job.raw_data["union_id"] == USER_ZGL
    assert job.raw_data["session_key"] == "agent:main:feishu:dm:chat-1"
    assert job.source["user_id_alt"] == USER_ZGL
    assert adapter.outbound_requests == []
