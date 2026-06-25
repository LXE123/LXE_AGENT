from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

from gateway.emitter import GatewayEmitter
from gateway.models import OutboundRequest
from platforms.feishu.gateway import FeishuStreamAdapter
from platforms.feishu.typing_indicator import FeishuTypingIndicator
import platforms.feishu.typing_indicator as typing_mod


class _FakeReactionClient:
    def __init__(self, *, add_error: Exception | None = None, delete_error: Exception | None = None) -> None:
        self.add_error = add_error
        self.delete_error = delete_error
        self.add_calls: list[tuple[str, str]] = []
        self.delete_calls: list[tuple[str, str]] = []

    async def add_message_reaction(self, message_id: str, emoji_type: str) -> str:
        self.add_calls.append((message_id, emoji_type))
        if self.add_error is not None:
            raise self.add_error
        return "reaction-1"

    async def delete_message_reaction(self, message_id: str, reaction_id: str) -> None:
        self.delete_calls.append((message_id, reaction_id))
        if self.delete_error is not None:
            raise self.delete_error


def _ctx(extra_data: dict[str, Any] | None = None) -> SimpleNamespace:
    safe_extra_data = dict(extra_data or {})
    return SimpleNamespace(
        message_id=str(safe_extra_data.get("source_message_id") or "msg-1"),
        extra_data=safe_extra_data,
        raw_data={
            "platform": "feishu",
            "chat_id": "chat-1",
            "source_message_id": str(safe_extra_data.get("source_message_id") or "msg-1"),
        },
    )


class _FakeDispatcherBuilder:
    def __init__(self) -> None:
        self.registrations: list[tuple[str, Any]] = []

    def register_p2_im_message_receive_v1(self, handler: Any) -> "_FakeDispatcherBuilder":
        self.registrations.append(("message_receive", handler))
        return self

    def register_p2_im_message_reaction_created_v1(self, handler: Any) -> "_FakeDispatcherBuilder":
        self.registrations.append(("reaction_created", handler))
        return self

    def register_p2_im_message_reaction_deleted_v1(self, handler: Any) -> "_FakeDispatcherBuilder":
        self.registrations.append(("reaction_deleted", handler))
        return self

    def build(self) -> SimpleNamespace:
        return SimpleNamespace(registrations=list(self.registrations))


def _reaction_event(emoji_type: str = "Typing") -> SimpleNamespace:
    return SimpleNamespace(
        event=SimpleNamespace(
            message_id="msg-source",
            reaction_type=SimpleNamespace(emoji_type=emoji_type),
        )
    )


def test_typing_indicator_start_adds_reaction_and_saves_state(monkeypatch) -> None:
    patches: list[tuple[str, dict[str, str]]] = []

    async def fake_save_response_route_patch(response_route_id: str, patch: dict[str, str]) -> None:
        patches.append((response_route_id, dict(patch)))

    monkeypatch.setattr(typing_mod, "save_response_route_patch", fake_save_response_route_patch)
    client = _FakeReactionClient()

    async def _run() -> None:
        indicator = FeishuTypingIndicator(client=client)
        await indicator.start(_ctx({"source_message_id": "msg-source"}), "route-1")

    asyncio.run(_run())

    assert client.add_calls == [("msg-source", "Typing")]
    assert patches == [
        (
            "route-1",
            {
                "typing_message_id": "msg-source",
                "typing_reaction_id": "reaction-1",
            },
        )
    ]


def test_typing_indicator_stop_deletes_reaction_and_clears_state(monkeypatch) -> None:
    patches: list[tuple[str, dict[str, str]]] = []

    async def fake_save_response_route_patch(response_route_id: str, patch: dict[str, str]) -> None:
        patches.append((response_route_id, dict(patch)))

    monkeypatch.setattr(typing_mod, "save_response_route_patch", fake_save_response_route_patch)
    client = _FakeReactionClient()

    async def _run() -> None:
        indicator = FeishuTypingIndicator(client=client)
        await indicator.stop(
            _ctx(
                {
                    "source_message_id": "msg-source",
                    "typing_message_id": "msg-source",
                    "typing_reaction_id": "reaction-1",
                }
            ),
            "route-1",
        )

    asyncio.run(_run())

    assert client.delete_calls == [("msg-source", "reaction-1")]
    assert patches == [
        (
            "route-1",
            {
                "typing_message_id": "",
                "typing_reaction_id": "",
            },
        )
    ]


def test_typing_indicator_is_best_effort_for_missing_state_and_api_errors(monkeypatch) -> None:
    patches: list[tuple[str, dict[str, str]]] = []

    async def fake_save_response_route_patch(response_route_id: str, patch: dict[str, str]) -> None:
        patches.append((response_route_id, dict(patch)))

    monkeypatch.setattr(typing_mod, "save_response_route_patch", fake_save_response_route_patch)
    client = _FakeReactionClient(add_error=RuntimeError("reaction denied"), delete_error=RuntimeError("gone"))

    async def _run() -> None:
        indicator = FeishuTypingIndicator(client=client)
        await indicator.start(_ctx({"source_message_id": "msg-source"}), "route-1")
        await indicator.stop(_ctx({"source_message_id": "msg-source"}), "route-1")
        await indicator.stop(
            _ctx(
                {
                    "source_message_id": "msg-source",
                    "typing_message_id": "msg-source",
                    "typing_reaction_id": "reaction-1",
                }
            ),
            "route-1",
        )

    asyncio.run(_run())

    assert client.add_calls == [("msg-source", "Typing")]
    assert client.delete_calls == [("msg-source", "reaction-1")]
    assert patches == [
        (
            "route-1",
            {
                "typing_message_id": "",
                "typing_reaction_id": "",
            },
        ),
        (
            "route-1",
            {
                "typing_message_id": "",
                "typing_reaction_id": "",
            },
        ),
    ]


def test_feishu_gateway_dispatches_typing_indicator_action(monkeypatch) -> None:
    calls: list[dict[str, Any]] = []

    async def fake_load_send_context(response_route_id: str, *, session_id: str = "") -> SimpleNamespace:
        return SimpleNamespace(response_route_id=response_route_id, session_id=session_id)

    class _FakeTypingIndicator:
        async def handle(self, ctx: Any, response_route_id: str, *, operation: str) -> None:
            calls.append(
                {
                    "ctx": ctx,
                    "response_route_id": response_route_id,
                    "operation": operation,
                }
            )

    import platforms.feishu.gateway as feishu_gateway

    monkeypatch.setattr(feishu_gateway, "_load_send_context", fake_load_send_context)
    adapter = FeishuStreamAdapter.__new__(FeishuStreamAdapter)
    adapter._typing_indicator = _FakeTypingIndicator()
    request = OutboundRequest(
        action="typing_indicator",
        platform="feishu",
        payload={"operation": "start"},
        session_id="session-1",
        response_route_id="route-1",
    )

    asyncio.run(FeishuStreamAdapter.handle_outbound(adapter, request))

    assert calls == [
        {
            "ctx": SimpleNamespace(response_route_id="route-1", session_id="session-1"),
            "response_route_id": "route-1",
            "operation": "start",
        }
    ]


def test_gateway_emitter_sends_typing_indicator_outbound(monkeypatch) -> None:
    class _FakeAdapter:
        def __init__(self) -> None:
            self.requests: list[OutboundRequest] = []

        async def handle_outbound(self, request: OutboundRequest) -> None:
            self.requests.append(request)

    class _FakeRegistry:
        def __init__(self, adapter: _FakeAdapter) -> None:
            self.adapter = adapter

        def get(self, platform: str) -> _FakeAdapter:
            assert platform == "feishu"
            return self.adapter

    async def fake_load_agent_session(session_id: str) -> SimpleNamespace:
        return SimpleNamespace(session_id=session_id, source={"platform": "feishu"})

    async def fake_load_response_route_context(response_route_id: str) -> SimpleNamespace:
        return SimpleNamespace(response_route_id=response_route_id, platform="feishu")

    import gateway.emitter as emitter_mod

    monkeypatch.setattr(emitter_mod, "load_agent_session", fake_load_agent_session)
    monkeypatch.setattr(emitter_mod, "load_response_route_context", fake_load_response_route_context)
    adapter = _FakeAdapter()
    emitter = GatewayEmitter(registry=_FakeRegistry(adapter))

    async def _run() -> None:
        await emitter.emit_typing_indicator(
            session_id="session-1",
            response_route_id="route-1",
            operation="stop",
            emit_id="emit-1",
        )

    asyncio.run(_run())

    assert len(adapter.requests) == 1
    request = adapter.requests[0]
    assert request.action == "typing_indicator"
    assert request.payload == {"operation": "stop"}
    assert request.session_id == "session-1"
    assert request.response_route_id == "route-1"
    assert request.event_id == "emit-1"


def test_feishu_gateway_registers_reaction_event_processors() -> None:
    adapter = FeishuStreamAdapter.__new__(FeishuStreamAdapter)
    builder = _FakeDispatcherBuilder()
    fake_lark = SimpleNamespace(
        EventDispatcherHandler=SimpleNamespace(builder=lambda *_args: builder),
    )

    handler = adapter._build_event_dispatcher_handler(fake_lark)

    assert [name for name, _handler in builder.registrations] == [
        "message_receive",
        "reaction_created",
        "reaction_deleted",
    ]
    assert handler.registrations == builder.registrations
    assert all(callable(registered_handler) for _name, registered_handler in builder.registrations)


def test_feishu_gateway_ignores_typing_reaction_created() -> None:
    adapter = FeishuStreamAdapter.__new__(FeishuStreamAdapter)
    emitted: list[Any] = []
    adapter.emit = emitted.append  # type: ignore[method-assign]

    adapter._build_reaction_created_handler(object)(_reaction_event("Typing"))

    assert emitted == []


def test_feishu_gateway_ignores_non_typing_reaction_created() -> None:
    adapter = FeishuStreamAdapter.__new__(FeishuStreamAdapter)
    emitted: list[Any] = []
    adapter.emit = emitted.append  # type: ignore[method-assign]

    adapter._build_reaction_created_handler(object)(_reaction_event("THUMBSUP"))

    assert emitted == []


def test_feishu_gateway_ignores_reaction_deleted() -> None:
    adapter = FeishuStreamAdapter.__new__(FeishuStreamAdapter)
    emitted: list[Any] = []
    adapter.emit = emitted.append  # type: ignore[method-assign]

    adapter._build_reaction_deleted_handler(object)(_reaction_event("Typing"))

    assert emitted == []
