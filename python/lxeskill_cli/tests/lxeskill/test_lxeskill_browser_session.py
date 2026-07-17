from __future__ import annotations

import asyncio
import json

from lxeskill import cli as lxeskill
from lxeskill import browser as lxeskill_browser
from services.browser.tools import client as browser_client
from services.browser.tools.models import ToolExecutionResult


def test_browser_command_runs_on_a_fresh_db_without_agent_sessions(tmp_path, monkeypatch) -> None:
    # Regression: agent_sessions is a Bun-runtime table in agent.sqlite3; the
    # Python browser CLI must not touch it. A fresh lxeskill.sqlite3 without
    # that table used to fail with "no such table: agent_sessions".
    monkeypatch.setenv("LXE_SQLITE_DB_PATH", str(tmp_path / "fresh.sqlite3"))
    observed_sessions: list[str] = []

    async def fake_execute(tool_name, arguments, session):
        observed_sessions.append(session.session_id)
        return ToolExecutionResult(
            tool_name=tool_name,
            success=True,
            content=[{"type": "text", "text": "ready"}],
        )

    monkeypatch.setattr(browser_client, "execute_browser_tool", fake_execute)

    data, files = asyncio.run(
        lxeskill_browser.execute_browser_command(
            {"name": "ziniao_browser"},
            {"action": "get_status"},
            "session-1",
        )
    )

    assert data == {"content": [{"type": "text", "text": "ready"}]}
    assert files == []
    assert observed_sessions == ["session-1"]


def test_browser_vision_exposes_model_input_path_but_not_terminal_file(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("LXE_SQLITE_DB_PATH", str(tmp_path / "fresh.sqlite3"))
    screenshot = tmp_path / "artifacts" / "browser" / "shot.png"
    screenshot.parent.mkdir(parents=True)
    screenshot.write_bytes(b"png")

    async def fake_execute(tool_name, arguments, session):
        return ToolExecutionResult(
            tool_name=tool_name,
            success=True,
            content=[{"type": "text", "text": "captured"}],
            files=[str(screenshot)],
        )

    monkeypatch.setattr(browser_client, "execute_browser_tool", fake_execute)
    monkeypatch.setattr(lxeskill_browser, "allowed_output_file", lambda path, **kwargs: screenshot.resolve())
    data, files = asyncio.run(lxeskill_browser.execute_browser_command(
        {"name": "ziniao_page", "owner_skills": ["ziniao-browser"]},
        {"action": "browser_vision", "store_id": "store-1"},
        "session-vision",
    ))

    assert data == {
        "content": [{"type": "text", "text": "captured"}],
        "screenshot_path": str(screenshot.resolve()),
    }
    assert files == []


def test_browser_session_resolution_prefers_explicit_id(monkeypatch) -> None:
    monkeypatch.setenv("LXE_AGENT_SESSION_ID", "environment-session")
    entry = {"input_schema": {"type": "object", "properties": {"action": {"type": "string"}}}}

    arguments, session_id = lxeskill._input_arguments(
        entry,
        ["--session-id", "explicit-session", "--action", "get_status"],
    )

    assert arguments == {"action": "get_status"}
    assert session_id == "explicit-session"


def test_browser_command_reports_session_required_as_environment_error(capsys, monkeypatch) -> None:
    monkeypatch.delenv("LXE_AGENT_SESSION_ID", raising=False)

    assert lxeskill.main(["browser", "store", "--action", "get_status"]) == lxeskill.EXIT_ENVIRONMENT

    record = json.loads(capsys.readouterr().out)
    assert record["ok"] is False
    assert record["error"]["code"] == "session_required"


def test_browser_command_surfaces_store_busy_error(monkeypatch) -> None:
    async def fake_execute(tool_name, arguments, session):
        return ToolExecutionResult(
            tool_name=tool_name,
            success=False,
            error_code="store_busy",
            error_message="timed out waiting for lock",
        )

    monkeypatch.setattr(browser_client, "execute_browser_tool", fake_execute)

    try:
        asyncio.run(
            lxeskill_browser.execute_browser_command(
                {"name": "ziniao_page"},
                {"action": "browser_snapshot", "store_id": "store-1"},
                "session-1",
            )
        )
    except lxeskill_browser.BrowserCliError as exc:
        assert exc.code == "store_busy"
    else:
        raise AssertionError("expected BrowserCliError")


def test_store_sessions_work_on_a_fresh_db_without_init_schema(tmp_path, monkeypatch) -> None:
    # Regression: the Bun gateway only bootstraps TS-owned tables, so a fresh
    # deployment hit "no such table: ziniao_store_sessions" on the first
    # standalone `lxeskill browser store --action get_status`.
    monkeypatch.setenv("LXE_SQLITE_DB_PATH", str(tmp_path / "fresh.sqlite3"))
    from shared.db.sqlite import store_sessions

    assert store_sessions.list_store_sessions(host_id="host-1") == []
    state = store_sessions.upsert_store_session(
        browser_oauth="oauth-1",
        browser_id=7,
        browser_name="demo",
        debugging_port=9222,
        download_path=str(tmp_path / "downloads"),
        browser_path=str(tmp_path / "browser.exe"),
        host_id="host-1",
    )
    assert state.browser_id == 7
    loaded = store_sessions.load_store_session("oauth-1", host_id="host-1")
    assert loaded is not None and loaded.debugging_port == 9222
