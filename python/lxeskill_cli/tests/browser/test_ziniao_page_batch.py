from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from lxeskill import browser as lxeskill_browser
from lxeskill import cli as lxeskill_cli
from services.browser.store import store_driver_session as store_driver_session_module
from services.browser.tools import client as browser_client
from services.browser.tools import executor
from services.browser.tools.models import ToolExecutionResult
from services.browser.tools.schema import build_browser_tool_call


STORE_ID = "store-1"


# --- schema normalization ---


def test_batch_normalizes_steps_and_propagates_store_id() -> None:
    call = build_browser_tool_call(
        name="ziniao_page",
        arguments={
            "store_id": STORE_ID,
            "steps": [
                {"action": "browser_click", "ref": "aid-5"},
                {"action": "browser_type", "ref": "aid-7", "text": "hello"},
                {"action": "browser_snapshot"},
            ],
        },
    )

    steps = call.arguments["steps"]
    assert [step["action"] for step in steps] == ["browser_click", "browser_type", "browser_snapshot"]
    assert all(step["store_id"] == STORE_ID for step in steps)
    assert "action" not in call.arguments


def test_batch_rejects_action_alongside_steps() -> None:
    with pytest.raises(ValueError, match="either action or steps"):
        build_browser_tool_call(
            name="ziniao_page",
            arguments={
                "store_id": STORE_ID,
                "action": "browser_snapshot",
                "steps": [{"action": "browser_snapshot"}],
            },
        )


def test_batch_rejects_vision_before_last_step() -> None:
    with pytest.raises(ValueError, match="final step"):
        build_browser_tool_call(
            name="ziniao_page",
            arguments={
                "store_id": STORE_ID,
                "steps": [
                    {"action": "browser_vision"},
                    {"action": "browser_snapshot"},
                ],
            },
        )


def test_batch_rejects_too_many_steps() -> None:
    with pytest.raises(ValueError, match="at most 20"):
        build_browser_tool_call(
            name="ziniao_page",
            arguments={
                "store_id": STORE_ID,
                "steps": [{"action": "browser_snapshot"}] * 21,
            },
        )


def test_batch_reports_step_position_for_invalid_step() -> None:
    with pytest.raises(ValueError, match="step 2"):
        build_browser_tool_call(
            name="ziniao_page",
            arguments={
                "store_id": STORE_ID,
                "steps": [
                    {"action": "browser_snapshot"},
                    {"action": "browser_click"},
                ],
            },
        )


# --- CLI parsing ---


def test_cli_parses_repeated_steps_flags_as_object_array() -> None:
    entry = {
        "input_schema": {
            "type": "object",
            "properties": {
                "store_id": {"type": "string"},
                "steps": {"type": "array", "items": {"type": "object"}},
            },
        }
    }

    arguments, _ = lxeskill_cli._input_arguments(
        entry,
        [
            "--store-id", STORE_ID,
            "--steps", '{"action":"browser_click","ref":"aid-5"}',
            "--steps", '{"action":"browser_snapshot"}',
        ],
    )

    assert arguments == {
        "store_id": STORE_ID,
        "steps": [
            {"action": "browser_click", "ref": "aid-5"},
            {"action": "browser_snapshot"},
        ],
    }


def test_cli_rejects_non_object_steps_value() -> None:
    entry = {
        "input_schema": {
            "type": "object",
            "properties": {"steps": {"type": "array", "items": {"type": "object"}}},
        }
    }

    with pytest.raises(lxeskill_cli.LxeSkillError, match="JSON object"):
        lxeskill_cli._input_arguments(entry, ["--steps", "not-json"])


# --- executor batch loop ---


class _FakeSession:
    def __init__(self) -> None:
        self.snapshot_calls = 0

    def snapshot(self, **kwargs):
        self.snapshot_calls += 1
        return {"url": "https://example.test/start", "title": "start", "seq": self.snapshot_calls}


def _patch_batch_session(monkeypatch, session: _FakeSession, attach_calls: list[str]) -> None:
    from contextlib import contextmanager

    @contextmanager
    def fake_workflow_session(runtime, *, store_id, output_dir):
        attach_calls.append(store_id)
        yield session

    monkeypatch.setattr(executor, "_page_workflow_session", fake_workflow_session)


def test_batch_executes_all_steps_with_one_attach_and_threads_snapshots(monkeypatch, tmp_path) -> None:
    session = _FakeSession()
    attach_calls: list[str] = []
    dispatch_calls: list[tuple[str, dict]] = []
    _patch_batch_session(monkeypatch, session, attach_calls)

    def fake_dispatch(sess, arguments, *, output_dir, before_snapshot=None):
        action = str(arguments.get("action") or "")
        dispatch_calls.append((action, dict(before_snapshot or {})))
        return {
            "summary": f"{action} done",
            "after_snapshot": {"url": f"https://example.test/{len(dispatch_calls)}", "title": action},
            "payload": {"action": action},
        }

    monkeypatch.setattr(executor, "dispatch_ziniao_page", fake_dispatch)

    result = executor.execute_browser_tool(
        SimpleNamespace(session_id="session-1"),
        tool_name="ziniao_page",
        arguments={
            "store_id": STORE_ID,
            "steps": [
                {"action": "browser_click", "ref": "aid-5"},
                {"action": "browser_type", "ref": "aid-7", "text": "hi"},
            ],
        },
    )

    assert result.success is True
    assert attach_calls == [STORE_ID]
    # click, type, plus the automatic trailing snapshot
    assert [item[0] for item in dispatch_calls] == ["browser_click", "browser_type", "browser_snapshot"]
    # step 2 reuses step 1's after_snapshot instead of re-snapshotting
    assert dispatch_calls[1][1]["url"] == "https://example.test/1"
    assert session.snapshot_calls == 1
    payload = dict(result.payload)
    assert payload["action"] == "batch"
    assert payload["completed"] is True
    assert [step["ok"] for step in payload["steps"]] == [True, True]
    assert result.after_snapshot["title"] == "browser_snapshot"


def test_batch_stops_at_failed_step_and_returns_recovery_snapshot(monkeypatch, tmp_path) -> None:
    session = _FakeSession()
    attach_calls: list[str] = []
    dispatch_calls: list[str] = []
    _patch_batch_session(monkeypatch, session, attach_calls)

    def fake_dispatch(sess, arguments, *, output_dir, before_snapshot=None):
        action = str(arguments.get("action") or "")
        dispatch_calls.append(action)
        if action == "browser_click":
            raise RuntimeError("元素引用已失效")
        return {
            "summary": f"{action} done",
            "after_snapshot": {"url": "https://example.test/after", "title": action},
            "payload": {"action": action},
        }

    monkeypatch.setattr(executor, "dispatch_ziniao_page", fake_dispatch)

    result = executor.execute_browser_tool(
        SimpleNamespace(session_id="session-1"),
        tool_name="ziniao_page",
        arguments={
            "store_id": STORE_ID,
            "steps": [
                {"action": "browser_navigate", "url": "https://example.test"},
                {"action": "browser_click", "ref": "aid-5"},
                {"action": "browser_type", "ref": "aid-7", "text": "never-runs"},
            ],
        },
    )

    assert result.success is True
    payload = dict(result.payload)
    assert payload["completed"] is False
    assert payload["failed_step"] == 2
    assert "失效" in payload["failure_reason"]
    # step 3 never dispatched; recovery snapshot appended after the failure
    assert dispatch_calls == ["browser_navigate", "browser_click", "browser_snapshot"]
    assert [step["ok"] for step in payload["steps"]] == [True, False]
    assert result.after_snapshot["title"] == "browser_snapshot"


def test_batch_vision_last_returns_screenshot(monkeypatch, tmp_path) -> None:
    session = _FakeSession()
    attach_calls: list[str] = []
    _patch_batch_session(monkeypatch, session, attach_calls)
    shot = tmp_path / "shot.png"
    shot.write_bytes(b"png")

    def fake_dispatch(sess, arguments, *, output_dir, before_snapshot=None):
        action = str(arguments.get("action") or "")
        payload = {
            "summary": f"{action} done",
            "after_snapshot": {"url": "https://example.test", "title": action},
            "payload": {"action": action},
        }
        if action == "browser_vision":
            payload["screenshot_path"] = str(shot)
        return payload

    monkeypatch.setattr(executor, "dispatch_ziniao_page", fake_dispatch)

    result = executor.execute_browser_tool(
        SimpleNamespace(session_id="session-1"),
        tool_name="ziniao_page",
        arguments={
            "store_id": STORE_ID,
            "steps": [
                {"action": "browser_click", "ref": "aid-5"},
                {"action": "browser_vision"},
            ],
        },
    )

    assert result.success is True
    assert result.screenshot_path == str(shot)


# --- CLI contract for batch vision ---


def test_browser_command_returns_screenshot_path_for_batch_ending_in_vision(tmp_path, monkeypatch) -> None:
    screenshot = tmp_path / "shot.png"
    screenshot.write_bytes(b"png")

    async def fake_execute(tool_name, arguments, session):
        return ToolExecutionResult(
            tool_name=tool_name,
            success=True,
            content=[{"type": "text", "text": "batch ok"}],
            files=[str(screenshot)],
        )

    monkeypatch.setattr(browser_client, "execute_browser_tool", fake_execute)
    monkeypatch.setattr(lxeskill_browser, "allowed_output_file", lambda path, **kwargs: screenshot.resolve())

    data, files = asyncio.run(lxeskill_browser.execute_browser_command(
        {"name": "ziniao_page", "owner_skills": ["ziniao-browser"]},
        {
            "store_id": STORE_ID,
            "steps": [
                {"action": "browser_click", "ref": "aid-5"},
                {"action": "browser_vision"},
            ],
        },
        "session-1",
    ))

    assert data["screenshot_path"] == str(screenshot.resolve())
    assert files == []


def test_browser_command_tolerates_batch_that_stopped_before_vision(monkeypatch) -> None:
    async def fake_execute(tool_name, arguments, session):
        return ToolExecutionResult(
            tool_name=tool_name,
            success=True,
            content=[{"type": "text", "text": "stopped at step 1"}],
        )

    monkeypatch.setattr(browser_client, "execute_browser_tool", fake_execute)

    data, files = asyncio.run(lxeskill_browser.execute_browser_command(
        {"name": "ziniao_page", "owner_skills": ["ziniao-browser"]},
        {
            "store_id": STORE_ID,
            "steps": [
                {"action": "browser_click", "ref": "aid-5"},
                {"action": "browser_vision"},
            ],
        },
        "session-1",
    ))

    assert data == {"content": [{"type": "text", "text": "stopped at step 1"}]}
    assert files == []


def test_browser_command_wraps_schema_validation_as_invalid_arguments(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(
        store_driver_session_module, "internal_root", lambda: tmp_path,
    )

    with pytest.raises(lxeskill_browser.BrowserCliError) as captured:
        asyncio.run(lxeskill_browser.execute_browser_command(
            {"name": "ziniao_page"},
            {
                "store_id": STORE_ID,
                "steps": [
                    {"action": "browser_vision"},
                    {"action": "browser_click", "ref": "aid-5"},
                ],
            },
            "session-1",
        ))

    assert captured.value.code == "invalid_arguments"
