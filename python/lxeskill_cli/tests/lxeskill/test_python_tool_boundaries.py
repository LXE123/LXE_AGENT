from __future__ import annotations

import asyncio
import json
import sys

import pytest
from types import ModuleType
from types import SimpleNamespace

from lxeskill.business import load_catalog
from lxeskill.business import execute_module_json
from services.browser.tools import client
from services.browser.tools.models import ExecuteToolResult, ToolExecutionResult


def test_browser_client_exposes_async_tool_boundary(monkeypatch) -> None:
    session = SimpleNamespace(session_id="session-1")

    def fake_execute(runtime, *, tool_name: str, arguments: dict):
        assert runtime is session
        assert tool_name == "ziniao_browser"
        assert arguments == {"action": "get_status"}
        return ExecuteToolResult(
            tool_name=tool_name,
            success=True,
            summary="browser ready",
            payload={"action": "get_status", "data": {"client_running": True}},
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
    assert result.files == []


def test_browser_vision_returns_a_path_without_base64(tmp_path, monkeypatch) -> None:
    screenshot = tmp_path / "page.png"
    screenshot.write_bytes(b"not-decoded-by-client")
    session = SimpleNamespace(session_id="session-1")

    def fake_execute(runtime, *, tool_name: str, arguments: dict):
        return ExecuteToolResult(
            tool_name="ziniao_page",
            success=True,
            summary="captured",
            screenshot_path=str(screenshot),
            payload={"action": "browser_vision"},
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
    assert "amazon_logistic_quote" not in catalog
    assert "logistics_rate_import" not in catalog
    assert catalog["mabang_resolve_fba_store"]["owner_skills"]
    assert catalog["browser_auth_refresh"]["exposed"] is False


def test_business_adapter_requires_the_run_contract(monkeypatch) -> None:
    module_name = "tests.fake_run_contract_business_cli"
    module = ModuleType(module_name)

    def run(arguments: dict) -> dict:
        assert arguments == {"store_name": "Demo"}
        return {"success": True, "message": "ok"}

    module.run = run  # type: ignore[attr-defined]
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

    legacy = ModuleType("tests.fake_legacy_main_cli")
    legacy.main = lambda: 0  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "tests.fake_legacy_main_cli", legacy)
    with pytest.raises(RuntimeError, match="no callable run"):
        execute_module_json({"module": "tests.fake_legacy_main_cli"}, {}, {"session_id": "session"})


def test_business_adapter_can_deliver_declared_artifacts_on_failure(monkeypatch) -> None:
    module_name = "tests.fake_partial_artifact_business_cli"
    module = ModuleType(module_name)
    module.run = lambda _arguments: {  # type: ignore[attr-defined]
        "success": False,
        "purchase_summary_xlsx": "/safe/purchase.xlsx",
        "exception": "contract generation failed",
    }
    monkeypatch.setitem(sys.modules, module_name, module)
    monkeypatch.setattr(
        "lxeskill.business.collect_declared_artifacts",
        lambda _entry, _payload: ["/safe/purchase.xlsx"],
    )

    ok, _content, files, error = execute_module_json(
        {
            "module": module_name,
            "deliver_artifacts_on_failure": True,
            "artifact_paths": [
                {"field": "purchase_summary_xlsx", "role": "deliverable"}
            ],
        },
        {},
        {"session_id": "session"},
    )

    assert ok is False
    assert files == ["/safe/purchase.xlsx"]
    assert error == {
        "code": "business_cli_failed",
        "message": "contract generation failed",
    }


def test_business_adapter_projects_only_an_explicit_terminal_projection(monkeypatch) -> None:
    module_name = "tests.projected_success_business_cli"
    module = ModuleType(module_name)
    module.run = lambda _arguments: {  # type: ignore[attr-defined]
        "success": True,
        "artifacts": [{"path": "/safe/final.xlsx"}],
        "terminal_projection": {
            "data": {"platform": "zhihui_tms", "row_count": 2},
        },
    }
    monkeypatch.setitem(sys.modules, module_name, module)
    monkeypatch.setattr(
        "lxeskill.business.collect_declared_artifacts",
        lambda _entry, _payload: ["/safe/final.xlsx"],
    )

    ok, content, files, error = execute_module_json(
        {"module": module_name}, {}, {"session_id": "session"},
    )

    assert ok is True
    assert json.loads(content[0]["text"]) == {"platform": "zhihui_tms", "row_count": 2}
    assert files == ["/safe/final.xlsx"]
    assert error is None


def test_business_adapter_projects_an_explicit_partial_error(monkeypatch) -> None:
    module_name = "tests.projected_partial_business_cli"
    module = ModuleType(module_name)
    module.run = lambda _arguments: {  # type: ignore[attr-defined]
        "success": False,
        "exception": "download failed",
        "terminal_projection": {
            "data": {"platform": "zhihui_tms", "partial": True},
            "error": {"code": "tms_export_partial", "message": "download failed"},
        },
    }
    monkeypatch.setitem(sys.modules, module_name, module)

    ok, content, files, error = execute_module_json(
        {"module": module_name}, {}, {"session_id": "session"},
    )

    assert ok is False
    assert json.loads(content[0]["text"]) == {"platform": "zhihui_tms", "partial": True}
    assert files == []
    assert error == {"code": "tms_export_partial", "message": "download failed"}


@pytest.mark.parametrize("platform", ["yacang", "shangman", "mabang"])
def test_business_adapter_keeps_unprojected_legacy_payloads_unchanged(platform, monkeypatch) -> None:
    module_name = f"tests.legacy_{platform}_business_cli"
    module = ModuleType(module_name)
    payload = {"success": False, "platform": platform, "exception": f"{platform} failed"}
    module.run = lambda _arguments: payload  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, module_name, module)

    ok, content, files, error = execute_module_json(
        {"module": module_name}, {}, {"session_id": "session"},
    )

    assert ok is False
    assert json.loads(content[0]["text"]) == payload
    assert files == []
    assert error == {"code": "business_cli_failed", "message": f"{platform} failed"}
