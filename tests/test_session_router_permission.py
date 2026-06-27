from __future__ import annotations

import asyncio
from types import SimpleNamespace

import gateway.session_router as router_mod
from gateway.models import InboundEvent
from gateway.session_router import SessionRouter
from shared.permission_policy import (
    BOT_ID_AMAZON_REPLENISH,
    BOT_ID_AMAZON_REPLENISH_GROUP_2,
    BOT_ID_AMAZON_REPLENISH_GROUP_3,
    BOT_ID_LXE_CLAW,
    BOT_ID_LXE_FBA_AGENT,
    USER_AMAZON_REPLENISH_GROUP_1_MEMBER,
    USER_AMAZON_REPLENISH_GROUP_2_MEMBER,
    USER_AMAZON_REPLENISH_GROUP_3_MEMBER,
    USER_DEV_GROUP_MEMBER,
    USER_LYX,
    USER_ZGL,
)

BOT_ID_AMAZON_FBA_MACHINE_2 = "cli_aaa5e081aa211bee"
USER_AMAZON_FBA_MACHINE_2_MEMBER = "on_d73c763c561e81ed7e554dd59e286095"
BOT_ID_AMAZON_REPLENISH_GROUP_1_MACHINE_2 = "cli_aaa5e06b1bb81bcb"
USER_AMAZON_REPLENISH_GROUP_1_MACHINE_2_MEMBER = "on_5b073ea5ba8e6e5bae65c81cdfc849f4"

OPEN_ID_LYX = "ou_lyx_open_id"
OPEN_ID_ZGL = "ou_zgl_open_id"
OPEN_ID_AMAZON_FBA_MACHINE_2_MEMBER = "ou_amazon_fba_machine_2_member_open_id"
OPEN_ID_AMAZON_REPLENISH_GROUP_1_MEMBER = "ou_amazon_replenish_group_1_member_open_id"
OPEN_ID_AMAZON_REPLENISH_GROUP_1_MACHINE_2_MEMBER = "ou_amazon_replenish_group_1_machine_2_member_open_id"
OPEN_ID_AMAZON_REPLENISH_GROUP_2_MEMBER = "ou_amazon_replenish_group_2_member_open_id"
OPEN_ID_AMAZON_REPLENISH_GROUP_3_MEMBER = "ou_amazon_replenish_group_3_member_open_id"
OPEN_ID_DEV_GROUP_MEMBER = "ou_dev_group_member_open_id"


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


def _event(
    *,
    user_id: str,
    union_id: str,
    app_id: str,
    chat_type: str = "p2p",
    source_extra: dict | None = None,
) -> InboundEvent:
    return InboundEvent(
        platform="feishu",
        event_type="agent_message",
        user_input="hello",
        user_id=user_id,
        conversation_id="chat-1",
        is_group=(chat_type == "group"),
        message_id="msg-1",
        sender_nick="sender",
        response_route_id="route-1",
        union_id=union_id,
        source={
            "platform": "feishu",
            "chat_id": "chat-1",
            "chat_type": chat_type,
            "user_id": user_id,
            "user_id_alt": union_id,
            "user_name": "sender",
            **({"extra": dict(source_extra)} if source_extra else {}),
        },
        raw_data={
            "platform": "feishu",
            "app_id": app_id,
            "union_id": union_id,
            "chat_type": chat_type,
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

    async def fake_create_response_route_context(_ctx) -> None:
        return None

    async def fail_db_call(*_args, **_kwargs):
        raise AssertionError("permission denied route should not touch agent session storage")

    monkeypatch.setattr(router_mod, "create_response_route_context", fake_create_response_route_context)
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

    async def fake_create_response_route_context(_ctx) -> None:
        return None

    async def fail_db_call(*_args, **_kwargs):
        raise AssertionError("permission denied route should not touch agent session storage")

    monkeypatch.setattr(router_mod, "create_response_route_context", fake_create_response_route_context)
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

    async def fake_create_response_route_context(_ctx) -> None:
        return None

    async def fail_db_call(*_args, **_kwargs):
        raise AssertionError("permission denied route should not touch agent session storage")

    monkeypatch.setattr(router_mod, "create_response_route_context", fake_create_response_route_context)
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

    async def fake_create_response_route_context(_ctx) -> None:
        return None

    async def fake_load_session(*_args, **_kwargs):
        return None

    async def fake_create_agent_session(**kwargs):
        calls["created"] += 1
        return SimpleNamespace(
            session_id="session-1",
            source=kwargs["source"],
            state_data=kwargs["state_data"],
        )

    async def fake_pop_pending_events(_session_id: str):
        return []

    monkeypatch.setattr(router_mod, "create_response_route_context", fake_create_response_route_context)
    monkeypatch.setattr(router_mod, "load_agent_session", fake_load_session)
    monkeypatch.setattr(router_mod, "create_agent_session", fake_create_agent_session)
    monkeypatch.setattr(router_mod, "pop_agent_session_pending_events", fake_pop_pending_events)

    decision = asyncio.run(
        router.route_message(
            _event(
                user_id=OPEN_ID_ZGL,
                union_id=USER_ZGL,
                app_id=BOT_ID_LXE_FBA_AGENT,
                source_extra={
                    "bot_app_id": BOT_ID_LXE_FBA_AGENT,
                    "bot_id": "ou_bot",
                    "bot_name": "FBA业务助手",
                },
            )
        )
    )

    assert decision.route_kind == "agent_message"
    assert calls["created"] == 1
    assert len(scheduler.jobs) == 1
    job, front = scheduler.jobs[0]
    assert not front
    assert job.session_id == "session-1"
    assert job.session_key == f"agent:main:feishu:dm:chat-1"
    assert job.response_route_id == "route-1"
    assert job.user_id == USER_ZGL
    assert job.raw_data["app_id"] == BOT_ID_LXE_FBA_AGENT
    assert job.raw_data["union_id"] == USER_ZGL
    assert job.raw_data["session_key"] == "agent:main:feishu:dm:chat-1"
    assert job.source["user_id_alt"] == USER_ZGL
    assert job.source["extra"]["bot_app_id"] == BOT_ID_LXE_FBA_AGENT
    assert job.source["extra"]["bot_name"] == "FBA业务助手"
    assert adapter.outbound_requests == []


def test_router_allows_fba_machine_2_member_on_fba_machine_2_bot(monkeypatch) -> None:
    adapter = _FakeAdapter()
    scheduler = _FakeScheduler()
    router = _router(adapter, scheduler)
    calls = {"created": 0}

    async def fake_create_response_route_context(_ctx) -> None:
        return None

    async def fake_load_session(*_args, **_kwargs):
        return None

    async def fake_create_agent_session(**kwargs):
        calls["created"] += 1
        return SimpleNamespace(
            session_id="session-1",
            source=kwargs["source"],
            state_data=kwargs["state_data"],
        )

    async def fake_pop_pending_events(_session_id: str):
        return []

    monkeypatch.setattr(router_mod, "create_response_route_context", fake_create_response_route_context)
    monkeypatch.setattr(router_mod, "load_agent_session", fake_load_session)
    monkeypatch.setattr(router_mod, "create_agent_session", fake_create_agent_session)
    monkeypatch.setattr(router_mod, "pop_agent_session_pending_events", fake_pop_pending_events)

    decision = asyncio.run(
        router.route_message(
            _event(
                user_id=OPEN_ID_AMAZON_FBA_MACHINE_2_MEMBER,
                union_id=USER_AMAZON_FBA_MACHINE_2_MEMBER,
                app_id=BOT_ID_AMAZON_FBA_MACHINE_2,
                chat_type="group",
                source_extra={
                    "bot_app_id": BOT_ID_AMAZON_FBA_MACHINE_2,
                    "bot_id": "ou_bot_fba_machine_2",
                    "bot_name": "AMAZON-FBA-二号机",
                },
            )
        )
    )

    assert decision.route_kind == "agent_message"
    assert calls["created"] == 1
    assert len(scheduler.jobs) == 1
    job, front = scheduler.jobs[0]
    assert not front
    assert job.session_id == "session-1"
    assert job.session_key == f"agent:main:feishu:group:chat-1:{USER_AMAZON_FBA_MACHINE_2_MEMBER}"
    assert job.response_route_id == "route-1"
    assert job.user_id == USER_AMAZON_FBA_MACHINE_2_MEMBER
    assert job.raw_data["app_id"] == BOT_ID_AMAZON_FBA_MACHINE_2
    assert job.raw_data["union_id"] == USER_AMAZON_FBA_MACHINE_2_MEMBER
    assert job.source["user_id_alt"] == USER_AMAZON_FBA_MACHINE_2_MEMBER
    assert job.source["extra"]["bot_app_id"] == BOT_ID_AMAZON_FBA_MACHINE_2
    assert job.source["extra"]["bot_name"] == "AMAZON-FBA-二号机"
    assert adapter.outbound_requests == []


def test_router_allows_group_1_member_on_group_1_bot(monkeypatch) -> None:
    adapter = _FakeAdapter()
    scheduler = _FakeScheduler()
    router = _router(adapter, scheduler)
    calls = {"created": 0}

    async def fake_create_response_route_context(_ctx) -> None:
        return None

    async def fake_load_session(*_args, **_kwargs):
        return None

    async def fake_create_agent_session(**kwargs):
        calls["created"] += 1
        return SimpleNamespace(
            session_id="session-1",
            source=kwargs["source"],
            state_data=kwargs["state_data"],
        )

    async def fake_pop_pending_events(_session_id: str):
        return []

    monkeypatch.setattr(router_mod, "create_response_route_context", fake_create_response_route_context)
    monkeypatch.setattr(router_mod, "load_agent_session", fake_load_session)
    monkeypatch.setattr(router_mod, "create_agent_session", fake_create_agent_session)
    monkeypatch.setattr(router_mod, "pop_agent_session_pending_events", fake_pop_pending_events)

    decision = asyncio.run(
        router.route_message(
            _event(
                user_id=OPEN_ID_AMAZON_REPLENISH_GROUP_1_MEMBER,
                union_id=USER_AMAZON_REPLENISH_GROUP_1_MEMBER,
                app_id=BOT_ID_AMAZON_REPLENISH,
                chat_type="group",
                source_extra={
                    "bot_app_id": BOT_ID_AMAZON_REPLENISH,
                    "bot_id": "ou_bot_group_1",
                    "bot_name": "AMAZON-备货一组",
                },
            )
        )
    )

    assert decision.route_kind == "agent_message"
    assert calls["created"] == 1
    assert len(scheduler.jobs) == 1
    job, front = scheduler.jobs[0]
    assert not front
    assert job.session_id == "session-1"
    assert job.session_key == f"agent:main:feishu:group:chat-1:{USER_AMAZON_REPLENISH_GROUP_1_MEMBER}"
    assert job.response_route_id == "route-1"
    assert job.user_id == USER_AMAZON_REPLENISH_GROUP_1_MEMBER
    assert job.raw_data["app_id"] == BOT_ID_AMAZON_REPLENISH
    assert job.raw_data["union_id"] == USER_AMAZON_REPLENISH_GROUP_1_MEMBER
    assert job.source["user_id_alt"] == USER_AMAZON_REPLENISH_GROUP_1_MEMBER
    assert job.source["extra"]["bot_app_id"] == BOT_ID_AMAZON_REPLENISH
    assert job.source["extra"]["bot_name"] == "AMAZON-备货一组"
    assert adapter.outbound_requests == []


def test_router_allows_group_2_member_on_group_2_bot(monkeypatch) -> None:
    adapter = _FakeAdapter()
    scheduler = _FakeScheduler()
    router = _router(adapter, scheduler)
    calls = {"created": 0}

    async def fake_create_response_route_context(_ctx) -> None:
        return None

    async def fake_load_session(*_args, **_kwargs):
        return None

    async def fake_create_agent_session(**kwargs):
        calls["created"] += 1
        return SimpleNamespace(
            session_id="session-1",
            source=kwargs["source"],
            state_data=kwargs["state_data"],
        )

    async def fake_pop_pending_events(_session_id: str):
        return []

    monkeypatch.setattr(router_mod, "create_response_route_context", fake_create_response_route_context)
    monkeypatch.setattr(router_mod, "load_agent_session", fake_load_session)
    monkeypatch.setattr(router_mod, "create_agent_session", fake_create_agent_session)
    monkeypatch.setattr(router_mod, "pop_agent_session_pending_events", fake_pop_pending_events)

    decision = asyncio.run(
        router.route_message(
            _event(
                user_id=OPEN_ID_AMAZON_REPLENISH_GROUP_2_MEMBER,
                union_id=USER_AMAZON_REPLENISH_GROUP_2_MEMBER,
                app_id=BOT_ID_AMAZON_REPLENISH_GROUP_2,
                chat_type="group",
                source_extra={
                    "bot_app_id": BOT_ID_AMAZON_REPLENISH_GROUP_2,
                    "bot_id": "ou_bot_group_2",
                    "bot_name": "AMAZON-备货二组",
                },
            )
        )
    )

    assert decision.route_kind == "agent_message"
    assert calls["created"] == 1
    assert len(scheduler.jobs) == 1
    job, front = scheduler.jobs[0]
    assert not front
    assert job.session_id == "session-1"
    assert job.session_key == f"agent:main:feishu:group:chat-1:{USER_AMAZON_REPLENISH_GROUP_2_MEMBER}"
    assert job.response_route_id == "route-1"
    assert job.user_id == USER_AMAZON_REPLENISH_GROUP_2_MEMBER
    assert job.raw_data["app_id"] == BOT_ID_AMAZON_REPLENISH_GROUP_2
    assert job.raw_data["union_id"] == USER_AMAZON_REPLENISH_GROUP_2_MEMBER
    assert job.source["user_id_alt"] == USER_AMAZON_REPLENISH_GROUP_2_MEMBER
    assert job.source["extra"]["bot_app_id"] == BOT_ID_AMAZON_REPLENISH_GROUP_2
    assert job.source["extra"]["bot_name"] == "AMAZON-备货二组"
    assert adapter.outbound_requests == []


def test_router_allows_group_1_machine_2_member_on_group_1_machine_2_bot(monkeypatch) -> None:
    adapter = _FakeAdapter()
    scheduler = _FakeScheduler()
    router = _router(adapter, scheduler)
    calls = {"created": 0}

    async def fake_create_response_route_context(_ctx) -> None:
        return None

    async def fake_load_session(*_args, **_kwargs):
        return None

    async def fake_create_agent_session(**kwargs):
        calls["created"] += 1
        return SimpleNamespace(
            session_id="session-1",
            source=kwargs["source"],
            state_data=kwargs["state_data"],
        )

    async def fake_pop_pending_events(_session_id: str):
        return []

    monkeypatch.setattr(router_mod, "create_response_route_context", fake_create_response_route_context)
    monkeypatch.setattr(router_mod, "load_agent_session", fake_load_session)
    monkeypatch.setattr(router_mod, "create_agent_session", fake_create_agent_session)
    monkeypatch.setattr(router_mod, "pop_agent_session_pending_events", fake_pop_pending_events)

    decision = asyncio.run(
        router.route_message(
            _event(
                user_id=OPEN_ID_AMAZON_REPLENISH_GROUP_1_MACHINE_2_MEMBER,
                union_id=USER_AMAZON_REPLENISH_GROUP_1_MACHINE_2_MEMBER,
                app_id=BOT_ID_AMAZON_REPLENISH_GROUP_1_MACHINE_2,
                chat_type="group",
                source_extra={
                    "bot_app_id": BOT_ID_AMAZON_REPLENISH_GROUP_1_MACHINE_2,
                    "bot_id": "ou_bot_group_1_machine_2",
                    "bot_name": "AMAZON-备货一组-二号机",
                },
            )
        )
    )

    assert decision.route_kind == "agent_message"
    assert calls["created"] == 1
    assert len(scheduler.jobs) == 1
    job, front = scheduler.jobs[0]
    assert not front
    assert job.session_id == "session-1"
    assert job.session_key == f"agent:main:feishu:group:chat-1:{USER_AMAZON_REPLENISH_GROUP_1_MACHINE_2_MEMBER}"
    assert job.response_route_id == "route-1"
    assert job.user_id == USER_AMAZON_REPLENISH_GROUP_1_MACHINE_2_MEMBER
    assert job.raw_data["app_id"] == BOT_ID_AMAZON_REPLENISH_GROUP_1_MACHINE_2
    assert job.raw_data["union_id"] == USER_AMAZON_REPLENISH_GROUP_1_MACHINE_2_MEMBER
    assert job.source["user_id_alt"] == USER_AMAZON_REPLENISH_GROUP_1_MACHINE_2_MEMBER
    assert job.source["extra"]["bot_app_id"] == BOT_ID_AMAZON_REPLENISH_GROUP_1_MACHINE_2
    assert job.source["extra"]["bot_name"] == "AMAZON-备货一组-二号机"
    assert adapter.outbound_requests == []


def test_router_allows_dev_member_on_claw_bot(monkeypatch) -> None:
    adapter = _FakeAdapter()
    scheduler = _FakeScheduler()
    router = _router(adapter, scheduler)
    calls = {"created": 0}

    async def fake_create_response_route_context(_ctx) -> None:
        return None

    async def fake_load_session(*_args, **_kwargs):
        return None

    async def fake_create_agent_session(**kwargs):
        calls["created"] += 1
        return SimpleNamespace(
            session_id="session-1",
            source=kwargs["source"],
            state_data=kwargs["state_data"],
        )

    async def fake_pop_pending_events(_session_id: str):
        return []

    monkeypatch.setattr(router_mod, "create_response_route_context", fake_create_response_route_context)
    monkeypatch.setattr(router_mod, "load_agent_session", fake_load_session)
    monkeypatch.setattr(router_mod, "create_agent_session", fake_create_agent_session)
    monkeypatch.setattr(router_mod, "pop_agent_session_pending_events", fake_pop_pending_events)

    decision = asyncio.run(
        router.route_message(
            _event(
                user_id=OPEN_ID_DEV_GROUP_MEMBER,
                union_id=USER_DEV_GROUP_MEMBER,
                app_id=BOT_ID_LXE_CLAW,
                source_extra={
                    "bot_app_id": BOT_ID_LXE_CLAW,
                    "bot_id": "ou_bot_dev",
                    "bot_name": "LXE_CLAW",
                },
            )
        )
    )

    assert decision.route_kind == "agent_message"
    assert calls["created"] == 1
    assert len(scheduler.jobs) == 1
    job, front = scheduler.jobs[0]
    assert not front
    assert job.session_id == "session-1"
    assert job.session_key == "agent:main:feishu:dm:chat-1"
    assert job.response_route_id == "route-1"
    assert job.user_id == USER_DEV_GROUP_MEMBER
    assert job.raw_data["app_id"] == BOT_ID_LXE_CLAW
    assert job.raw_data["union_id"] == USER_DEV_GROUP_MEMBER
    assert job.source["user_id_alt"] == USER_DEV_GROUP_MEMBER
    assert job.source["extra"]["bot_app_id"] == BOT_ID_LXE_CLAW
    assert job.source["extra"]["bot_name"] == "LXE_CLAW"
    assert adapter.outbound_requests == []


def test_router_allows_group_3_member_on_group_3_bot(monkeypatch) -> None:
    adapter = _FakeAdapter()
    scheduler = _FakeScheduler()
    router = _router(adapter, scheduler)
    calls = {"created": 0}

    async def fake_create_response_route_context(_ctx) -> None:
        return None

    async def fake_load_session(*_args, **_kwargs):
        return None

    async def fake_create_agent_session(**kwargs):
        calls["created"] += 1
        return SimpleNamespace(
            session_id="session-1",
            source=kwargs["source"],
            state_data=kwargs["state_data"],
        )

    async def fake_pop_pending_events(_session_id: str):
        return []

    monkeypatch.setattr(router_mod, "create_response_route_context", fake_create_response_route_context)
    monkeypatch.setattr(router_mod, "load_agent_session", fake_load_session)
    monkeypatch.setattr(router_mod, "create_agent_session", fake_create_agent_session)
    monkeypatch.setattr(router_mod, "pop_agent_session_pending_events", fake_pop_pending_events)

    decision = asyncio.run(
        router.route_message(
            _event(
                user_id=OPEN_ID_AMAZON_REPLENISH_GROUP_3_MEMBER,
                union_id=USER_AMAZON_REPLENISH_GROUP_3_MEMBER,
                app_id=BOT_ID_AMAZON_REPLENISH_GROUP_3,
                chat_type="group",
                source_extra={
                    "bot_app_id": BOT_ID_AMAZON_REPLENISH_GROUP_3,
                    "bot_id": "ou_bot_group_3",
                    "bot_name": "AMAZON-备货三组",
                },
            )
        )
    )

    assert decision.route_kind == "agent_message"
    assert calls["created"] == 1
    assert len(scheduler.jobs) == 1
    job, front = scheduler.jobs[0]
    assert not front
    assert job.session_id == "session-1"
    assert job.session_key == f"agent:main:feishu:group:chat-1:{USER_AMAZON_REPLENISH_GROUP_3_MEMBER}"
    assert job.response_route_id == "route-1"
    assert job.user_id == USER_AMAZON_REPLENISH_GROUP_3_MEMBER
    assert job.raw_data["app_id"] == BOT_ID_AMAZON_REPLENISH_GROUP_3
    assert job.raw_data["union_id"] == USER_AMAZON_REPLENISH_GROUP_3_MEMBER
    assert job.source["user_id_alt"] == USER_AMAZON_REPLENISH_GROUP_3_MEMBER
    assert job.source["extra"]["bot_app_id"] == BOT_ID_AMAZON_REPLENISH_GROUP_3
    assert job.source["extra"]["bot_name"] == "AMAZON-备货三组"
    assert adapter.outbound_requests == []
