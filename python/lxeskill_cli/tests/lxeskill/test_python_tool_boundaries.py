from __future__ import annotations

import asyncio
import sys
from types import ModuleType
from types import SimpleNamespace

from lxeskill.business import load_catalog
from lxeskill.business import execute_module_json
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


def test_browser_vision_returns_a_path_without_base64(tmp_path, monkeypatch) -> None:
    screenshot = tmp_path / "page.png"
    screenshot.write_bytes(b"not-decoded-by-client")
    session = SimpleNamespace(session_id="session-1", state_data={})

    def fake_execute(runtime, *, tool_name: str, arguments: dict):
        return ExecuteToolResult(
            tool_name="ziniao_page",
            success=True,
            summary="captured",
            screenshot_path=str(screenshot),
            payload={"action": "browser_vision"},
            state_data={},
        )

    monkeypatch.setattr(client.browser_executor, "execute_browser_tool", fake_execute)
    result = asyncio.run(client.execute_browser_tool(
        "ziniao_page",
        {"action": "browser_vision", "store_id": "store-1"},
        session,
    ))

    assert result.files == [str(screenshot.resolve())]
    assert result.content == [
        {"type": "text", "text": f"Screenshot saved for model reading: {screenshot.resolve()}"}
    ]
    assert all(item.get("type") != "image" for item in result.content)


def test_catalog_covers_active_business_skills() -> None:
    catalog = load_catalog()
    assert catalog["amazon_logistic_quote"]["module"] == "services.agent_cli.amazon_logistic.run"
    assert catalog["logistics_rate_import"]["owner_skills"] == ["fba-logistics-rate-import"]
    assert catalog["mabang_resolve_fba_store"]["owner_skills"]
    assert catalog["browser_auth_refresh"]["exposed"] is False


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
