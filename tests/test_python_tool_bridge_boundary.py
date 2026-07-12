from __future__ import annotations

import asyncio
import sys
from types import ModuleType
from types import SimpleNamespace

from py_tools import bridge
from py_tools.business import load_catalog
from py_tools.business import execute_module_json
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


def test_catalog_covers_active_business_skills_and_bridge_dispatches_module(monkeypatch) -> None:
    catalog = load_catalog()
    assert catalog["amazon_logistic_quote"]["module"] == "services.agent_cli.amazon_logistic.run"
    assert catalog["logistics_rate_import"]["owner_skills"] == ["fba-logistics-rate-import"]
    assert catalog["mabang_resolve_fba_store"]["owner_skills"]
    assert catalog["browser_auth_refresh"]["exposed"] is False

    calls: list[tuple[dict, dict, dict]] = []

    def fake_execute(entry: dict, arguments: dict, session: dict):
        calls.append((entry, arguments, session))
        return True, [{"type": "text", "text": "ok"}], [], None

    monkeypatch.setattr(bridge, "execute_module_json", fake_execute)
    response = asyncio.run(
        bridge._execute(
            {
                "protocol_version": "1",
                "call_id": "business-1",
                "tool_name": "mabang_resolve_fba_store",
                "arguments": {"store_name": "Demo"},
                "session": {
                    "session_id": "session-1",
                    "response_route_id": "route-current",
                    "user_id": "user-1",
                    "conversation_id": "conversation-1",
                },
            }
        )
    )
    assert response["ok"] is True
    assert calls[0][1] == {"store_name": "Demo"}
    assert calls[0][2]["response_route_id"] == "route-current"


def test_business_adapter_supports_legacy_zero_argument_main(monkeypatch) -> None:
    module_name = "tests.fake_zero_argument_business_cli"
    module = ModuleType(module_name)

    def main() -> int:
        assert sys.argv == [module_name, "--store-name", "Demo"]
        print('{"success":true,"message":"ok"}')
        return 0

    module.main = main  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, module_name, module)
    ok, content, files, error = execute_module_json(
        {"module": module_name},
        {"store_name": "Demo"},
        {"session_id": "session"},
    )
    assert ok is True
    assert content == [{"type": "text", "text": '{"success":true,"message":"ok"}'}]
    assert files == []
    assert error is None
