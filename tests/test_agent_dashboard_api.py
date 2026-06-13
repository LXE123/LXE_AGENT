from __future__ import annotations

import asyncio
import json
import os
import time

import pytest
from fastapi.testclient import TestClient

from agent_runtime.tools.process_sessions import (
    SessionStatus,
    clear_exec_sessions_for_tests,
    get_exec_session_registry,
)
from gateway.dashboard import api as dashboard_api
from gateway.dashboard.api import create_dashboard_app
from shared.agent_state import CONTEXT_KEY, RUNTIME_KEY
from shared.db.sqlite.agent_sessions import create_agent_session, update_agent_session
from shared.db.sqlite.bootstrap import init_schema
from shared.db.sqlite.session_messages import session_messages_path
from shared.env import upsert_project_env_values
from shared.llm import runtime_config as runtime_settings


@pytest.fixture(autouse=True)
def _clear_exec_sessions():
    asyncio.run(clear_exec_sessions_for_tests())
    yield
    asyncio.run(clear_exec_sessions_for_tests())


@pytest.fixture()
def dashboard_client(monkeypatch, tmp_path):
    monkeypatch.setenv("LXE_SQLITE_DB_PATH", str(tmp_path / "local_agent.sqlite3"))
    monkeypatch.setenv("AGENT_SESSION_BINDINGS_PATH", str(tmp_path / "sessions.json"))
    init_schema()
    return TestClient(create_dashboard_app())


def _configure_kimi_current_model(monkeypatch) -> None:
    monkeypatch.setenv("AGENT_LLM_PROVIDER", "kimi_coding")
    monkeypatch.setenv("AGENT_LLM_MODEL", "kimi-for-coding")
    monkeypatch.setenv("AGENT_LLM_THINKING_ENABLED", "0")
    monkeypatch.setenv("AGENT_LLM_THINKING_EFFORT", "low")
    monkeypatch.setattr(runtime_settings, "AGENT_LLM_PROVIDER", "kimi_coding")
    monkeypatch.setattr(runtime_settings, "AGENT_LLM_MODEL", "kimi-for-coding")
    monkeypatch.setattr(runtime_settings, "AGENT_LLM_THINKING_ENABLED", False)
    monkeypatch.setattr(runtime_settings, "AGENT_LLM_THINKING_EFFORT", "low")


def _redirect_dashboard_env_writes(monkeypatch, env_path):
    def write_env(values):
        upsert_project_env_values(values, path=env_path)

    monkeypatch.setattr(dashboard_api, "upsert_project_env_values", write_env)


def _state(messages: list[dict] | None = None) -> dict:
    return {
        RUNTIME_KEY: {},
        CONTEXT_KEY: {"messages": list(messages or [])},
    }


def _source(chat_id: str) -> dict:
    return {
        "platform": "feishu",
        "chat_id": chat_id,
        "chat_type": "group",
        "user_id": "ou_user",
        "user_id_alt": "on_union",
        "user_name": "Tester",
    }


def test_sessions_endpoint_orders_by_last_active_and_returns_metadata(dashboard_client):
    older = create_agent_session(
        session_id="older-session",
        source=_source("chat-old"),
        state_data=_state([{"role": "user", "content": "old"}]),
        title="Older",
    )
    newer = create_agent_session(
        session_id="newer-session",
        source=_source("chat-new"),
        state_data=_state([{"role": "user", "content": "new"}]),
        title="Newer",
    )
    update_agent_session(
        older.session_id,
        metrics_delta={"api_call_count": 1, "tool_call_count": 2, "input_tokens": 10, "output_tokens": 5},
    )
    update_agent_session(
        newer.session_id,
        metrics_delta={"api_call_count": 3, "tool_call_count": 4, "input_tokens": 20, "output_tokens": 6},
    )

    response = dashboard_client.get("/api/sessions?limit=10&offset=0")

    assert response.status_code == 200
    payload = response.json()
    assert payload["total"] == 2
    assert [item["session_id"] for item in payload["items"]] == ["newer-session", "older-session"]
    first = payload["items"][0]
    assert first["title"] == "Newer"
    assert first["source"]["chat_id"] == "chat-new"
    assert first["source_summary"] == {"platform": "feishu", "chat_type": "group"}
    assert first["message_count"] == 1
    assert first["api_call_count"] == 3
    assert first["tool_call_count"] == 4
    assert first["input_tokens"] == 20
    assert first["output_tokens"] == 6


def test_session_detail_endpoint_returns_metadata_and_messages(dashboard_client):
    created = create_agent_session(
        session_id="detail-session",
        source=_source("chat-detail"),
        state_data=_state(
            [
                {"role": "user", "content": "hello"},
                {
                    "role": "assistant",
                    "content": [{"type": "text", "text": "hi"}],
                },
            ]
        ),
        title="Detail",
    )

    response = dashboard_client.get(f"/api/sessions/{created.session_id}")

    assert response.status_code == 200
    payload = response.json()
    assert payload["session"]["session_id"] == "detail-session"
    assert payload["session"]["source_summary"] == {"platform": "feishu", "chat_type": "group"}
    assert payload["messages"] == [
        {"role": "user", "content": "hello"},
        {"role": "assistant", "content": [{"type": "text", "text": "hi"}]},
    ]
    assert payload["messages_page"] == {
        "total": 2,
        "raw_message_total": 2,
        "start": 0,
        "end": 2,
        "limit": 25,
        "current_page": 1,
        "total_pages": 1,
        "has_previous": False,
        "has_next": False,
    }


def test_session_detail_endpoint_defaults_to_latest_25_display_items(dashboard_client):
    messages = [{"role": "user", "content": f"message {index}"} for index in range(100)]
    created = create_agent_session(
        session_id="long-detail-session",
        source=_source("chat-long-detail"),
        state_data=_state(messages),
        title="Long Detail",
    )

    response = dashboard_client.get(f"/api/sessions/{created.session_id}")

    assert response.status_code == 200
    payload = response.json()
    assert [item["content"] for item in payload["messages"]] == [f"message {index}" for index in range(75, 100)]
    assert payload["session"]["message_count"] == 100
    assert payload["messages_page"] == {
        "total": 100,
        "raw_message_total": 100,
        "start": 75,
        "end": 100,
        "limit": 25,
        "current_page": 4,
        "total_pages": 4,
        "has_previous": True,
        "has_next": False,
    }


def test_session_detail_endpoint_loads_requested_display_page(dashboard_client):
    messages = [{"role": "user", "content": f"message {index}"} for index in range(100)]
    created = create_agent_session(
        session_id="previous-detail-session",
        source=_source("chat-previous-detail"),
        state_data=_state(messages),
        title="Previous Detail",
    )

    response = dashboard_client.get(f"/api/sessions/{created.session_id}?message_limit=20&message_page=2")

    assert response.status_code == 200
    payload = response.json()
    assert [item["content"] for item in payload["messages"]] == [f"message {index}" for index in range(20, 40)]
    assert payload["messages_page"] == {
        "total": 100,
        "raw_message_total": 100,
        "start": 20,
        "end": 40,
        "limit": 20,
        "current_page": 2,
        "total_pages": 5,
        "has_previous": True,
        "has_next": True,
    }


def test_session_detail_endpoint_clamps_message_page(dashboard_client):
    messages = [{"role": "user", "content": f"message {index}"} for index in range(12)]
    created = create_agent_session(
        session_id="clamp-detail-session",
        source=_source("chat-clamp-detail"),
        state_data=_state(messages),
        title="Clamp Detail",
    )

    response = dashboard_client.get(f"/api/sessions/{created.session_id}?message_limit=5&message_page=999")

    assert response.status_code == 200
    payload = response.json()
    assert [item["content"] for item in payload["messages"]] == [f"message {index}" for index in range(10, 12)]
    assert payload["messages_page"] == {
        "total": 12,
        "raw_message_total": 12,
        "start": 10,
        "end": 12,
        "limit": 5,
        "current_page": 3,
        "total_pages": 3,
        "has_previous": True,
        "has_next": False,
    }


def test_session_detail_endpoint_counts_contiguous_tools_as_one_display_item(dashboard_client):
    messages = [
        {"role": "user", "content": "start"},
        {
            "role": "assistant",
            "content": [{"type": "tool_call", "id": "tool_1", "name": "read", "arguments": {"path": "a"}}],
        },
        {"role": "tool", "content": [{"type": "tool_result", "tool_call_id": "tool_1", "content": "a"}]},
        {
            "role": "assistant",
            "content": [{"type": "tool_call", "id": "tool_2", "name": "exec", "arguments": {"command": "echo ok"}}],
        },
        {"role": "tool", "content": [{"type": "tool_result", "tool_call_id": "tool_2", "content": "ok"}]},
        {"role": "assistant", "content": [{"type": "text", "text": "done"}]},
    ]
    created = create_agent_session(
        session_id="tool-page-session",
        source=_source("chat-tool-page"),
        state_data=_state(messages),
        title="Tool Page",
    )

    response = dashboard_client.get(f"/api/sessions/{created.session_id}?message_limit=1&message_page=2")

    assert response.status_code == 200
    payload = response.json()
    assert payload["messages"] == messages[1:5]
    assert payload["session"]["message_count"] == 6
    assert payload["messages_page"] == {
        "total": 3,
        "raw_message_total": 6,
        "start": 1,
        "end": 2,
        "limit": 1,
        "current_page": 2,
        "total_pages": 3,
        "has_previous": True,
        "has_next": True,
    }


def test_session_detail_endpoint_returns_empty_messages_when_jsonl_missing(dashboard_client):
    created = create_agent_session(
        session_id="missing-jsonl-session",
        source=_source("chat-missing"),
        state_data=_state([{"role": "user", "content": "will be removed"}]),
        title="Missing JSONL",
    )
    session_messages_path(created.session_id).unlink()

    response = dashboard_client.get(f"/api/sessions/{created.session_id}")

    assert response.status_code == 200
    payload = response.json()
    assert payload["messages"] == []
    assert payload["messages_page"] == {
        "total": 0,
        "raw_message_total": 0,
        "start": 0,
        "end": 0,
        "limit": 25,
        "current_page": 1,
        "total_pages": 1,
        "has_previous": False,
        "has_next": False,
    }


def test_session_detail_endpoint_returns_404_for_missing_session(dashboard_client):
    response = dashboard_client.get("/api/sessions/not-found")

    assert response.status_code == 404


def test_models_endpoint_does_not_expose_api_keys(dashboard_client):
    response = dashboard_client.get("/api/models")

    assert response.status_code == 200
    payload = response.json()
    serialized = json.dumps(payload, ensure_ascii=False)
    assert payload["total"] >= 1
    assert "api_key" not in serialized
    assert "api-key" not in serialized.lower()
    assert all("configured" in item for item in payload["items"])
    kimi = next(item for item in payload["items"] if item["provider"] == "kimi_coding")
    assert kimi["thinking_request_style"] == "anthropic-budget"
    assert kimi["thinking_levels"] == ["off", "low"]
    assert kimi["thinking_level_labels"]["low"] == "on"
    assert kimi["thinking_default"] == "off"


def test_current_model_endpoint_returns_capabilities(dashboard_client, monkeypatch):
    _configure_kimi_current_model(monkeypatch)

    response = dashboard_client.get("/api/models/current")

    assert response.status_code == 200
    payload = response.json()
    assert payload["provider"]
    assert payload["model"]
    assert payload["capabilities"]["context_window_tokens"] > 0
    assert payload["capabilities"]["max_tokens"] > 0
    assert payload["capabilities"]["max_output_tokens"] == payload["capabilities"]["max_tokens"]
    assert payload["thinking_state"] == {
        "enabled": False,
        "level": "off",
        "label": "off",
        "editable": True,
    }


def test_current_model_thinking_patch_updates_runtime_and_env(dashboard_client, monkeypatch, tmp_path):
    _configure_kimi_current_model(monkeypatch)
    env_path = tmp_path / ".env"
    env_path.write_text(
        "SECRET_TOKEN=keep-me\n"
        "# keep this comment\n"
        "AGENT_LLM_THINKING_ENABLED=0\n",
        encoding="utf-8",
    )
    _redirect_dashboard_env_writes(monkeypatch, env_path)

    response = dashboard_client.patch("/api/models/current/thinking", json={"level": "low"})

    assert response.status_code == 200
    payload = response.json()
    assert payload["thinking_state"] == {
        "enabled": True,
        "level": "low",
        "label": "on",
        "editable": True,
    }
    assert runtime_settings.AGENT_LLM_THINKING_ENABLED is True
    assert runtime_settings.AGENT_LLM_THINKING_EFFORT == "low"
    assert os.environ["AGENT_LLM_THINKING_ENABLED"] == "1"
    assert os.environ["AGENT_LLM_THINKING_EFFORT"] == "low"
    env_text = env_path.read_text(encoding="utf-8")
    assert "SECRET_TOKEN=keep-me\n" in env_text
    assert "# keep this comment\n" in env_text
    assert "AGENT_LLM_THINKING_ENABLED=1\n" in env_text
    assert "AGENT_LLM_THINKING_EFFORT=low\n" in env_text

    response = dashboard_client.patch("/api/models/current/thinking", json={"level": "off"})

    assert response.status_code == 200
    payload = response.json()
    assert payload["thinking_state"]["level"] == "off"
    assert payload["thinking_state"]["enabled"] is False
    assert runtime_settings.AGENT_LLM_THINKING_ENABLED is False
    assert os.environ["AGENT_LLM_THINKING_ENABLED"] == "0"
    assert "AGENT_LLM_THINKING_ENABLED=0\n" in env_path.read_text(encoding="utf-8")


def test_current_model_thinking_patch_rejects_invalid_level_without_env_write(
    dashboard_client,
    monkeypatch,
    tmp_path,
):
    _configure_kimi_current_model(monkeypatch)
    env_path = tmp_path / ".env"
    env_path.write_text("AGENT_LLM_THINKING_ENABLED=0\n", encoding="utf-8")
    before = env_path.read_text(encoding="utf-8")
    _redirect_dashboard_env_writes(monkeypatch, env_path)

    response = dashboard_client.patch("/api/models/current/thinking", json={"level": "high"})

    assert response.status_code == 400
    assert env_path.read_text(encoding="utf-8") == before
    assert runtime_settings.AGENT_LLM_THINKING_ENABLED is False
    assert os.environ["AGENT_LLM_THINKING_ENABLED"] == "0"


def test_project_env_upsert_preserves_existing_content(tmp_path):
    env_path = tmp_path / ".env"
    env_path.write_text(
        "# local env\n"
        "SECRET_TOKEN=keep-me\n"
        "export AGENT_LLM_THINKING_ENABLED=0\n",
        encoding="utf-8",
    )

    upsert_project_env_values(
        {
            "AGENT_LLM_THINKING_ENABLED": "1",
            "AGENT_LLM_THINKING_EFFORT": "low",
        },
        path=env_path,
    )

    assert env_path.read_text(encoding="utf-8") == (
        "# local env\n"
        "SECRET_TOKEN=keep-me\n"
        "export AGENT_LLM_THINKING_ENABLED=1\n"
        "AGENT_LLM_THINKING_EFFORT=low\n"
    )


def test_toolsets_endpoint_lists_registered_tools_without_handlers(dashboard_client):
    response = dashboard_client.get("/api/tools/toolsets")

    assert response.status_code == 200
    payload = response.json()
    names = {item["name"] for item in payload["items"]}
    assert {"coding", "feishu_im", "browser"}.issubset(names)
    serialized = json.dumps(payload, ensure_ascii=False)
    assert "handler" not in serialized
    coding = next(item for item in payload["items"] if item["name"] == "coding")
    assert any(tool["name"] == "read" for tool in coding["tools"])


def test_background_tasks_endpoint_returns_empty_list(dashboard_client):
    response = dashboard_client.get("/api/background-tasks")

    assert response.status_code == 200
    payload = response.json()
    assert payload == {"items": [], "total": 0}


def test_background_tasks_endpoint_returns_running_exec_snapshot(dashboard_client):
    create_agent_session(
        session_id="agent-session-1",
        source=_source("chat-task"),
        state_data=_state(),
        title="Task Owner",
    )
    session = get_exec_session_registry().create(
        "uv run --frozen python very-long-script.py --with many --arguments",
        "D:/workspace",
        owner_session_id="agent-session-1",
        origin_turn_id="turn-1",
        response_route_id="route-1",
    )
    session.explicit_background = True
    session.pid = 12345
    session.stdout_tail = "latest stdout"
    session.stderr_tail = "latest stderr"

    response = dashboard_client.get("/api/background-tasks")

    assert response.status_code == 200
    payload = response.json()
    assert payload["total"] == 1
    task = payload["items"][0]
    assert task["task_id"] == session.id
    assert task["session_id"] == "agent-session-1"
    assert task["session_title"] == "Task Owner"
    assert task["origin_turn_id"] == "turn-1"
    assert task["response_route_id"] == "route-1"
    assert task["status"] == "running"
    assert task["pid"] == 12345
    assert task["background"] is True
    assert task["ended_at"] is None
    assert task["output_tail"] == "latest stdout\n[stderr]\nlatest stderr"
    serialized = json.dumps(payload, ensure_ascii=False)
    assert "process" not in serialized
    assert "stdout_task" not in serialized
    assert "handler" not in serialized


def test_background_tasks_endpoint_returns_completed_exec_metadata(dashboard_client):
    session = get_exec_session_registry().create(
        "echo done",
        "D:/workspace",
        owner_session_id="agent-session-2",
    )
    session.status = SessionStatus.COMPLETED
    session.exit_code = 0
    now = time.time()
    session.started_at = now - 2.5
    session.ended_at = now
    session.stdout_tail = "done"

    response = dashboard_client.get("/api/background-tasks")

    assert response.status_code == 200
    payload = response.json()
    task = payload["items"][0]
    assert task["session_id"] == "agent-session-2"
    assert task["session_title"] == ""
    assert task["status"] == "completed"
    assert task["exit_code"] == 0
    assert task["ended_at"] == now
    assert task["duration_sec"] == 2.5
    assert task["output_tail"] == "done"


def test_skills_endpoint_reads_skill_manifests(dashboard_client):
    response = dashboard_client.get("/api/skills")

    assert response.status_code == 200
    payload = response.json()
    assert payload["total"] >= 1
    first = payload["items"][0]
    assert {"name", "type", "description", "enabled", "location", "references"}.issubset(first)
