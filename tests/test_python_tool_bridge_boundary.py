from __future__ import annotations

import asyncio
from types import SimpleNamespace

from py_tools import bridge
from services.browser.tools import client
from services.browser.tools.models import ExecuteToolResult, ToolExecutionResult


def test_browser_client_exposes_async_tool_boundary(monkeypatch) -> None:
    session = SimpleNamespace(session_id="session-1", state_data={})

    def fake_execute(runtime, *, tool_name: str, arguments: dict):
        assert runtime is session
        assert tool_name == "ziniao_browser"
        assert arguments == {"action": "get_status"}
        runtime.state_data = {"runtime": {"session_activity_at": "2026-07-11T08:00:00Z"}}
        return ExecuteToolResult(
            tool_name=tool_name,
            success=True,
            summary="browser ready",
            payload={"action": "get_status", "data": {"client_running": True}},
            state_data={"runtime": {"session_activity_at": "2026-07-11T08:00:00Z"}},
        )

    monkeypatch.setattr(client.browser_executor, "execute_browser_tool", fake_execute)

    result = asyncio.run(
        client.execute_browser_tool(
            "ziniao_browser",
            {"action": "get_status"},
            session,
        )
    )

    assert isinstance(result, ToolExecutionResult)
    assert result.success is True
    assert result.content == [
        {"type": "text", "text": 'browser ready\nStatus JSON: {"client_running": true}'}
    ]
    assert result.state_patch == {"runtime": {"session_activity_at": "2026-07-11T08:00:00Z"}}
    assert result.files == []


def test_python_bridge_calls_service_boundary_without_runtime_context(monkeypatch) -> None:
    calls: list[tuple[str, dict, object]] = []

    async def fake_execute(tool_name: str, arguments: dict, session: object) -> ToolExecutionResult:
        calls.append((tool_name, arguments, session))
        return ToolExecutionResult(
            tool_name=tool_name,
            success=True,
            content=[{"type": "text", "text": "MEDIA:D:/artifacts/browser.png"}],
            state_patch={"browser": {"store_id": "store-1"}},
            files=["D:/artifacts/browser.png"],
        )

    monkeypatch.setattr(client, "execute_browser_tool", fake_execute)
    monkeypatch.setattr(
        bridge,
        "load_tool_state",
        lambda session_id: {"browser": {"session_id": "remote-1"}},
    )
    monkeypatch.setattr(
        "services.browser.store.ziniao_config.ziniao_tool_config_status",
        lambda: (True, ""),
    )

    response = asyncio.run(
        bridge._execute(
            {
                "protocol_version": "1",
                "call_id": "call-1",
                "tool_name": "ziniao_browser",
                "arguments": {"action": "get_status"},
                "session": {
                    "session_id": "session-1",
                    "response_route_id": "route-1",
                    "user_id": "user-1",
                    "conversation_id": "conversation-1",
                },
            }
        )
    )

    assert response == {
        "protocol_version": "1",
        "call_id": "call-1",
        "ok": True,
        "content": [{"type": "text", "text": "MEDIA:D:/artifacts/browser.png"}],
        "state_patch": {"browser": {"store_id": "store-1"}},
        "files": ["D:/artifacts/browser.png"],
    }
    assert len(calls) == 1
    assert calls[0][0:2] == ("ziniao_browser", {"action": "get_status"})
    assert getattr(calls[0][2], "session_id") == "session-1"
    assert getattr(calls[0][2], "state_data") == {
        "browser": {"session_id": "remote-1"}
    }
