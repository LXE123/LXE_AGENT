from __future__ import annotations

import asyncio
import json
import time

import pytest

from lxeskill import cli as lxeskill
from lxeskill import browser as lxeskill_browser
from services.browser.tools import client as browser_client
from services.browser.tools.models import ToolExecutionResult
from shared.db.sqlite.engine import connection_scope
from shared.process_lock import InterProcessLockTimeout


def _create_bun_agent_sessions_table() -> None:
    """Create the Bun-owned table needed by this cross-runtime integration test."""
    with connection_scope() as conn:
        conn.execute(
            """
            CREATE TABLE agent_sessions (
                session_id TEXT PRIMARY KEY,
                source TEXT NOT NULL DEFAULT '{}',
                model TEXT NOT NULL DEFAULT '',
                model_config TEXT NOT NULL DEFAULT '{}',
                created_at REAL NOT NULL,
                last_active_at REAL NOT NULL,
                message_count INTEGER NOT NULL DEFAULT 0,
                tool_call_count INTEGER NOT NULL DEFAULT 0,
                input_tokens INTEGER NOT NULL DEFAULT 0,
                output_tokens INTEGER NOT NULL DEFAULT 0,
                title TEXT NOT NULL DEFAULT '',
                api_call_count INTEGER NOT NULL DEFAULT 0
            )
            """
        )


def _insert_session(session_id: str, source: dict) -> None:
    now = time.time()
    with connection_scope() as conn:
        conn.execute(
            """
            INSERT INTO agent_sessions (
                session_id, source, model, model_config, created_at, last_active_at
            ) VALUES (?, ?, '', '{}', ?, ?)
            """,
            (session_id, json.dumps(source), now, now),
        )


def test_browser_command_persists_state_patch_and_restores_it_next_call(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("LXE_SQLITE_DB_PATH", str(tmp_path / "runtime.sqlite3"))
    monkeypatch.setattr(lxeskill_browser, "internal_root", lambda: tmp_path)
    _create_bun_agent_sessions_table()
    _insert_session(
        "session-1",
        {"tool_state": {"runtime": {}, "context": {"messages": []}}, "binding": "kept"},
    )
    observed_states: list[dict] = []

    async def fake_execute(tool_name, arguments, session):
        observed_states.append(dict(session.state_data))
        return ToolExecutionResult(
            tool_name=tool_name,
            success=True,
            content=[{"type": "text", "text": "ready"}],
            state_patch={
                "runtime": {"session_activity_at": "2026-07-12T08:00:00Z"},
                "context": {"messages": []},
            },
        )

    monkeypatch.setattr(browser_client, "execute_browser_tool", fake_execute)
    entry = {"name": "ziniao_browser"}

    first, files = asyncio.run(
        lxeskill_browser.execute_browser_command(entry, {"action": "get_status"}, "session-1")
    )
    asyncio.run(lxeskill_browser.execute_browser_command(entry, {"action": "get_status"}, "session-1"))

    assert first == {"content": [{"type": "text", "text": "ready"}]}
    assert files == []
    assert observed_states[0]["runtime"] == {}
    assert observed_states[1]["runtime"]["session_activity_at"] == "2026-07-12T08:00:00Z"
    with connection_scope() as conn:
        source = json.loads(conn.execute("SELECT source FROM agent_sessions WHERE session_id = 'session-1'").fetchone()["source"])
    assert source["binding"] == "kept"
    assert source["tool_state"]["runtime"]["session_activity_at"] == "2026-07-12T08:00:00Z"


def test_browser_vision_exposes_model_input_path_but_not_terminal_file(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("LXE_SQLITE_DB_PATH", str(tmp_path / "runtime.sqlite3"))
    monkeypatch.setattr(lxeskill_browser, "internal_root", lambda: tmp_path)
    _create_bun_agent_sessions_table()
    _insert_session("session-vision", {"tool_state": {"runtime": {}, "context": {"messages": []}}})
    screenshot = tmp_path / "artifacts" / "browser" / "shot.png"
    screenshot.parent.mkdir(parents=True)
    screenshot.write_bytes(b"png")

    async def fake_execute(tool_name, arguments, session):
        return ToolExecutionResult(
            tool_name=tool_name,
            success=True,
            content=[{"type": "text", "text": "captured"}],
            state_patch={"runtime": {}, "context": {"messages": []}},
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


def test_browser_command_reports_busy_session(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(lxeskill_browser, "internal_root", lambda: tmp_path)
    monkeypatch.setattr(
        lxeskill_browser,
        "interprocess_lock",
        lambda *args, **kwargs: (_ for _ in ()).throw(InterProcessLockTimeout("busy")),
    )

    with pytest.raises(lxeskill_browser.BrowserCliError, match="busy") as captured:
        asyncio.run(
            lxeskill_browser.execute_browser_command(
                {"name": "ziniao_browser"},
                {"action": "get_status"},
                "session-1",
            )
        )

    assert captured.value.code == "session_busy"


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
