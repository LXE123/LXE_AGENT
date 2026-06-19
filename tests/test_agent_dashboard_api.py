from __future__ import annotations

import asyncio
import json
import os
import time

import pytest
from fastapi.testclient import TestClient

from agent_runtime import skill_index as skill_index_module
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
from shared.db.sqlite.engine import connection_scope
from shared.db.sqlite.session_messages import session_messages_path
from shared.env import upsert_project_env_values
from shared.llm import runtime_config as runtime_settings
from shared.permission_policy import (
    BOT_ID_AMAZON_REPLENISH,
    BOT_ID_LXE_CLAW,
    BOT_ID_LXE_FBA_AGENT,
    SKILL_TYPE_AMAZON_FBA,
    SKILL_TYPE_AMAZON_REPLENISH,
    SKILL_TYPE_DEFAULT,
)


@pytest.fixture(autouse=True)
def _clear_exec_sessions():
    asyncio.run(clear_exec_sessions_for_tests())
    yield
    asyncio.run(clear_exec_sessions_for_tests())


@pytest.fixture()
def dashboard_client(monkeypatch, tmp_path):
    monkeypatch.setenv("LXE_SQLITE_DB_PATH", str(tmp_path / "local_agent.sqlite3"))
    monkeypatch.setenv("AGENT_SESSION_BINDINGS_PATH", str(tmp_path / "sessions.json"))
    monkeypatch.setattr(dashboard_api, "FEISHU_APP_ID", BOT_ID_LXE_CLAW)
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


def _configure_kimi_current_model_default_thinking(monkeypatch) -> None:
    monkeypatch.setenv("AGENT_LLM_PROVIDER", "kimi_coding")
    monkeypatch.setenv("AGENT_LLM_MODEL", "kimi-for-coding")
    monkeypatch.delenv("AGENT_LLM_THINKING_ENABLED", raising=False)
    monkeypatch.delenv("AGENT_LLM_THINKING_EFFORT", raising=False)
    monkeypatch.setattr(runtime_settings, "AGENT_LLM_PROVIDER", "kimi_coding")
    monkeypatch.setattr(runtime_settings, "AGENT_LLM_MODEL", "kimi-for-coding")
    monkeypatch.delattr(runtime_settings, "AGENT_LLM_THINKING_ENABLED", raising=False)
    monkeypatch.delattr(runtime_settings, "AGENT_LLM_THINKING_EFFORT", raising=False)


def _configure_deepseek_current_model(monkeypatch, *, effort: str = "low", model: str = "deepseek-v4-pro") -> None:
    monkeypatch.setenv("AGENT_LLM_PROVIDER", "deepseek")
    monkeypatch.setenv("AGENT_LLM_MODEL", model)
    monkeypatch.setenv("AGENT_LLM_THINKING_ENABLED", "1")
    monkeypatch.setenv("AGENT_LLM_THINKING_EFFORT", effort)
    monkeypatch.setattr(runtime_settings, "AGENT_LLM_PROVIDER", "deepseek")
    monkeypatch.setattr(runtime_settings, "AGENT_LLM_MODEL", model)
    monkeypatch.setattr(runtime_settings, "AGENT_LLM_THINKING_ENABLED", True)
    monkeypatch.setattr(runtime_settings, "AGENT_LLM_THINKING_EFFORT", effort)


def _configure_glm_current_model(monkeypatch) -> None:
    monkeypatch.setenv("AGENT_LLM_PROVIDER", "glm")
    monkeypatch.setenv("AGENT_LLM_MODEL", "glm-5v-turbo")
    monkeypatch.setenv("AGENT_LLM_THINKING_ENABLED", "1")
    monkeypatch.setenv("AGENT_LLM_THINKING_EFFORT", "high")
    monkeypatch.setattr(runtime_settings, "AGENT_LLM_PROVIDER", "glm")
    monkeypatch.setattr(runtime_settings, "AGENT_LLM_MODEL", "glm-5v-turbo")
    monkeypatch.setattr(runtime_settings, "AGENT_LLM_THINKING_ENABLED", True)
    monkeypatch.setattr(runtime_settings, "AGENT_LLM_THINKING_EFFORT", "high")


def _redirect_dashboard_env_writes(monkeypatch, env_path):
    def write_env(values):
        upsert_project_env_values(values, path=env_path)

    monkeypatch.setattr(dashboard_api, "upsert_project_env_values", write_env)


def _configure_model_api_keys(monkeypatch) -> None:
    monkeypatch.setenv("KIMI_CODE_API_KEY", "kimi-key")
    monkeypatch.setenv("DEEPSEEK_API", "deepseek-key")
    monkeypatch.setenv("GLM_API_KEY", "glm-key")


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


def _set_session_timestamp(session_id: str, timestamp: float) -> None:
    with connection_scope() as conn:
        conn.execute(
            """
            UPDATE agent_sessions
            SET created_at = ?,
                last_active_at = ?
            WHERE session_id = ?
            """,
            (float(timestamp), float(timestamp), session_id),
        )


def _install_dashboard_test_skill_root(monkeypatch, tmp_path) -> dict[str, str]:
    skills_root = tmp_path / "skills"
    skill_dir = skills_root / "dashboard-test-skill"
    references_dir = skill_dir / "references"
    references_dir.mkdir(parents=True)
    skill_text = """---
name: dashboard-test-skill
description: Dashboard skill body fixture.
type: dashboard_test
references:
  - path: references/example.md
    description: Example reference
---

## Body

This is the full SKILL.md body.
"""
    reference_text = "# Example Reference\n\nThis is a declared reference."
    secret_text = "# Secret\n\nThis file exists but is not declared."
    (skill_dir / "SKILL.md").write_text(skill_text, encoding="utf-8")
    (references_dir / "example.md").write_text(reference_text, encoding="utf-8")
    (references_dir / "secret.md").write_text(secret_text, encoding="utf-8")
    monkeypatch.setattr(skill_index_module, "SKILLS_ROOT", skills_root)
    monkeypatch.setattr(skill_index_module, "_SKILL_INDEX", None)
    return {
        "name": "dashboard-test-skill",
        "skill_text": skill_text,
        "reference_text": reference_text,
    }


def _install_dashboard_filter_skill_root(monkeypatch, tmp_path) -> None:
    skills_root = tmp_path / "skills"
    definitions = [
        ("dashboard-default-skill", SKILL_TYPE_DEFAULT),
        ("dashboard-fba-skill", SKILL_TYPE_AMAZON_FBA),
        ("dashboard-replenish-skill", SKILL_TYPE_AMAZON_REPLENISH),
    ]
    for name, skill_type in definitions:
        skill_dir = skills_root / name
        references_dir = skill_dir / "references"
        references_dir.mkdir(parents=True)
        (skill_dir / "SKILL.md").write_text(
            f"""---
name: {name}
description: {name} fixture.
type: {skill_type}
references:
  - path: references/example.md
    description: Example reference
---

## {name}
""",
            encoding="utf-8",
        )
        (references_dir / "example.md").write_text(f"# {name} Reference\n", encoding="utf-8")
    monkeypatch.setattr(skill_index_module, "SKILLS_ROOT", skills_root)
    monkeypatch.setattr(skill_index_module, "_SKILL_INDEX", None)


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
    assert payload["summary"] == {
        "total_sessions": 2,
        "tool_call_count": 6,
        "token_count": 41,
    }
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


def test_sessions_endpoint_paginates_with_total_and_summary(dashboard_client):
    for index in range(15):
        created = create_agent_session(
            session_id=f"page-session-{index:02d}",
            source=_source(f"chat-page-{index:02d}"),
            state_data=_state(),
            title=f"Page {index:02d}",
        )
        update_agent_session(
            created.session_id,
            metrics_delta={
                "tool_call_count": index,
                "input_tokens": index * 10,
                "output_tokens": index,
            },
        )
        _set_session_timestamp(created.session_id, 1_700_000_000 + index)

    response = dashboard_client.get("/api/sessions?limit=10&offset=10")

    assert response.status_code == 200
    payload = response.json()
    assert payload["total"] == 15
    assert payload["limit"] == 10
    assert payload["offset"] == 10
    assert [item["session_id"] for item in payload["items"]] == [
        "page-session-04",
        "page-session-03",
        "page-session-02",
        "page-session-01",
        "page-session-00",
    ]
    assert payload["summary"] == {
        "total_sessions": 15,
        "tool_call_count": 105,
        "token_count": 1155,
    }


def test_sessions_endpoint_searches_all_sessions_case_insensitively(dashboard_client):
    create_agent_session(
        session_id="alpha-session",
        source=_source("chat-alpha"),
        state_data=_state(),
        title="Alpha Shipment",
    )
    create_agent_session(
        session_id="source-session",
        source=_source("CHAT-SOURCE-NEEDLE"),
        state_data=_state(),
        title="Source Match",
    )
    create_agent_session(
        session_id="plain-session",
        source=_source("chat-plain"),
        state_data=_state(),
        title="Plain",
    )

    response = dashboard_client.get("/api/sessions?q=alpha&limit=10&offset=0")

    assert response.status_code == 200
    payload = response.json()
    assert payload["total"] == 1
    assert [item["session_id"] for item in payload["items"]] == ["alpha-session"]
    assert payload["summary"]["total_sessions"] == 3

    response = dashboard_client.get("/api/sessions?q=source-needle&limit=10&offset=0")

    assert response.status_code == 200
    payload = response.json()
    assert payload["total"] == 1
    assert [item["session_id"] for item in payload["items"]] == ["source-session"]


def test_sessions_endpoint_blank_search_matches_unfiltered(dashboard_client):
    create_agent_session(session_id="blank-a", source=_source("chat-blank-a"), state_data=_state(), title="Blank A")
    create_agent_session(session_id="blank-b", source=_source("chat-blank-b"), state_data=_state(), title="Blank B")

    unfiltered = dashboard_client.get("/api/sessions?limit=10&offset=0")
    blank = dashboard_client.get("/api/sessions?q=%20%20%20&limit=10&offset=0")

    assert unfiltered.status_code == 200
    assert blank.status_code == 200
    assert blank.json()["total"] == unfiltered.json()["total"] == 2
    assert [item["session_id"] for item in blank.json()["items"]] == [
        item["session_id"] for item in unfiltered.json()["items"]
    ]


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
        "limit": 10,
        "current_page": 1,
        "total_pages": 1,
        "has_previous": False,
        "has_next": False,
    }


def test_session_detail_endpoint_defaults_to_latest_10_display_items(dashboard_client):
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
    assert [item["content"] for item in payload["messages"]] == [f"message {index}" for index in range(90, 100)]
    assert payload["session"]["message_count"] == 100
    assert payload["messages_page"] == {
        "total": 100,
        "raw_message_total": 100,
        "start": 90,
        "end": 100,
        "limit": 10,
        "current_page": 10,
        "total_pages": 10,
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


def test_session_detail_endpoint_keeps_assistant_tool_turn_on_one_display_page(dashboard_client):
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
    assert payload["messages"] == messages[1:6]
    assert payload["session"]["message_count"] == 6
    assert payload["messages_page"] == {
        "total": 2,
        "raw_message_total": 6,
        "start": 1,
        "end": 2,
        "limit": 1,
        "current_page": 2,
        "total_pages": 2,
        "has_previous": True,
        "has_next": False,
    }


def test_session_detail_endpoint_keeps_contiguous_assistant_messages_on_one_display_page(dashboard_client):
    messages = [
        {"role": "user", "content": "start"},
        {"role": "assistant", "content": [{"type": "text", "text": "part 1"}]},
        {"role": "assistant", "content": [{"type": "text", "text": "part 2"}]},
        {"role": "user", "content": "next"},
    ]
    created = create_agent_session(
        session_id="assistant-turn-page-session",
        source=_source("chat-assistant-turn-page"),
        state_data=_state(messages),
        title="Assistant Turn Page",
    )

    response = dashboard_client.get(f"/api/sessions/{created.session_id}?message_limit=1&message_page=2")

    assert response.status_code == 200
    payload = response.json()
    assert payload["messages"] == messages[1:3]
    assert payload["session"]["message_count"] == 4
    assert payload["messages_page"] == {
        "total": 3,
        "raw_message_total": 4,
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
        "limit": 10,
        "current_page": 1,
        "total_pages": 1,
        "has_previous": False,
        "has_next": False,
    }


def test_session_detail_endpoint_returns_404_for_missing_session(dashboard_client):
    response = dashboard_client.get("/api/sessions/not-found")

    assert response.status_code == 404


def test_models_endpoint_does_not_expose_api_keys(dashboard_client, monkeypatch):
    _configure_model_api_keys(monkeypatch)

    response = dashboard_client.get("/api/models")

    assert response.status_code == 200
    payload = response.json()
    serialized = json.dumps(payload, ensure_ascii=False)
    assert payload["total"] >= 1
    assert "api_key" not in serialized
    assert "api-key" not in serialized.lower()
    assert all("configured" in item for item in payload["items"])
    kimi = next(item for item in payload["items"] if item["provider"] == "kimi_coding")
    assert kimi["configured"] is True
    assert kimi["selectable"] is True
    assert kimi["disabled_reason"] == ""
    assert [item["model"] for item in kimi["model_options"]] == ["kimi-for-coding"]
    assert kimi["thinking_request_style"] == "anthropic-budget"
    assert kimi["thinking_levels"] == ["off", "low"]
    assert kimi["thinking_level_labels"]["low"] == "on"
    assert kimi["thinking_default"] == "off"
    deepseek = next(item for item in payload["items"] if item["provider"] == "deepseek")
    assert deepseek["configured"] is True
    assert deepseek["selectable"] is True
    assert deepseek["disabled_reason"] == ""
    assert [item["model"] for item in deepseek["model_options"]] == ["deepseek-v4-pro", "deepseek-v4-flash"]
    assert deepseek["api_style"] == "anthropic-messages"
    assert deepseek["model"] == "deepseek-v4-pro"
    assert deepseek["thinking_request_style"] == "anthropic-effort"
    assert deepseek["thinking_levels"] == ["off", "high", "max"]
    assert deepseek["capabilities"]["context_window_tokens"] == 1000000
    assert deepseek["capabilities"]["max_tokens"] == 384000
    flash_option = next(item for item in deepseek["model_options"] if item["model"] == "deepseek-v4-flash")
    assert flash_option["thinking_levels"] == ["off", "high", "max"]
    assert flash_option["capabilities"]["context_window_tokens"] == 1000000

    glm = next(item for item in payload["items"] if item["provider"] == "glm")
    assert glm["configured"] is True
    assert glm["selectable"] is False
    assert glm["disabled_reason"] == "not selectable in WebUI"
    assert [item["model"] for item in glm["model_options"]] == ["glm-5v-turbo"]


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
        "editable": True,
    }


def test_current_model_endpoint_defaults_thinking_enabled(dashboard_client, monkeypatch):
    _configure_kimi_current_model_default_thinking(monkeypatch)

    response = dashboard_client.get("/api/models/current")

    assert response.status_code == 200
    payload = response.json()
    assert payload["thinking_state"] == {
        "enabled": True,
        "level": "low",
        "editable": True,
    }


def test_current_model_endpoint_returns_deepseek_anthropic_descriptor(dashboard_client, monkeypatch):
    _configure_deepseek_current_model(monkeypatch, effort="xhigh")

    response = dashboard_client.get("/api/models/current")

    assert response.status_code == 200
    payload = response.json()
    assert payload["provider"] == "deepseek"
    assert payload["api_style"] == "anthropic-messages"
    assert payload["model"] == "deepseek-v4-pro"
    assert payload["thinking_state"] == {
        "enabled": True,
        "level": "max",
        "editable": True,
    }
    assert payload["capabilities"]["context_window_tokens"] == 1000000
    assert payload["capabilities"]["max_tokens"] == 384000


def test_current_model_patch_switches_to_kimi_and_normalizes_thinking(dashboard_client, monkeypatch, tmp_path):
    _configure_model_api_keys(monkeypatch)
    _configure_deepseek_current_model(monkeypatch, effort="max")
    env_path = tmp_path / ".env"
    env_path.write_text(
        "AGENT_LLM_PROVIDER=deepseek\n"
        "AGENT_LLM_MODEL=deepseek-v4-pro\n"
        "AGENT_LLM_THINKING_ENABLED=1\n"
        "AGENT_LLM_THINKING_EFFORT=max\n",
        encoding="utf-8",
    )
    _redirect_dashboard_env_writes(monkeypatch, env_path)

    response = dashboard_client.patch(
        "/api/models/current",
        json={"provider": "kimi_coding", "model": "kimi-for-coding"},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["provider"] == "kimi_coding"
    assert payload["model"] == "kimi-for-coding"
    assert payload["thinking_state"] == {
        "enabled": True,
        "level": "low",
        "editable": True,
    }
    assert runtime_settings.AGENT_LLM_PROVIDER == "kimi_coding"
    assert runtime_settings.AGENT_LLM_MODEL == "kimi-for-coding"
    assert runtime_settings.AGENT_LLM_THINKING_ENABLED is True
    assert runtime_settings.AGENT_LLM_THINKING_EFFORT == "low"
    assert os.environ["AGENT_LLM_PROVIDER"] == "kimi_coding"
    assert os.environ["AGENT_LLM_MODEL"] == "kimi-for-coding"
    env_text = env_path.read_text(encoding="utf-8")
    assert "AGENT_LLM_PROVIDER=kimi_coding\n" in env_text
    assert "AGENT_LLM_MODEL=kimi-for-coding\n" in env_text
    assert "AGENT_LLM_THINKING_ENABLED=1\n" in env_text
    assert "AGENT_LLM_THINKING_EFFORT=low\n" in env_text


def test_current_model_patch_switches_between_deepseek_models(dashboard_client, monkeypatch, tmp_path):
    _configure_model_api_keys(monkeypatch)
    _configure_kimi_current_model(monkeypatch)
    monkeypatch.setenv("AGENT_LLM_THINKING_ENABLED", "1")
    monkeypatch.setenv("AGENT_LLM_THINKING_EFFORT", "low")
    monkeypatch.setattr(runtime_settings, "AGENT_LLM_THINKING_ENABLED", True)
    monkeypatch.setattr(runtime_settings, "AGENT_LLM_THINKING_EFFORT", "low")
    env_path = tmp_path / ".env"
    env_path.write_text(
        "AGENT_LLM_PROVIDER=kimi_coding\n"
        "AGENT_LLM_MODEL=kimi-for-coding\n"
        "AGENT_LLM_THINKING_ENABLED=1\n"
        "AGENT_LLM_THINKING_EFFORT=low\n",
        encoding="utf-8",
    )
    _redirect_dashboard_env_writes(monkeypatch, env_path)

    response = dashboard_client.patch(
        "/api/models/current",
        json={"provider": "deepseek", "model": "deepseek-v4-pro"},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["provider"] == "deepseek"
    assert payload["model"] == "deepseek-v4-pro"
    assert payload["thinking_state"] == {
        "enabled": True,
        "level": "high",
        "editable": True,
    }
    assert runtime_settings.AGENT_LLM_PROVIDER == "deepseek"
    assert runtime_settings.AGENT_LLM_MODEL == "deepseek-v4-pro"
    assert runtime_settings.AGENT_LLM_THINKING_ENABLED is True
    assert runtime_settings.AGENT_LLM_THINKING_EFFORT == "high"

    response = dashboard_client.patch(
        "/api/models/current",
        json={"provider": "deepseek", "model": "deepseek-v4-flash"},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["provider"] == "deepseek"
    assert payload["model"] == "deepseek-v4-flash"
    assert runtime_settings.AGENT_LLM_MODEL == "deepseek-v4-flash"
    assert os.environ["AGENT_LLM_MODEL"] == "deepseek-v4-flash"
    env_text = env_path.read_text(encoding="utf-8")
    assert "AGENT_LLM_PROVIDER=deepseek\n" in env_text
    assert "AGENT_LLM_MODEL=deepseek-v4-flash\n" in env_text
    assert "AGENT_LLM_THINKING_ENABLED=1\n" in env_text
    assert "AGENT_LLM_THINKING_EFFORT=high\n" in env_text


def test_current_model_patch_rejects_invalid_choices_without_env_write(dashboard_client, monkeypatch, tmp_path):
    _configure_model_api_keys(monkeypatch)
    _configure_kimi_current_model(monkeypatch)
    env_path = tmp_path / ".env"
    env_path.write_text(
        "AGENT_LLM_PROVIDER=kimi_coding\n"
        "AGENT_LLM_MODEL=kimi-for-coding\n"
        "AGENT_LLM_THINKING_ENABLED=0\n"
        "AGENT_LLM_THINKING_EFFORT=low\n",
        encoding="utf-8",
    )
    before = env_path.read_text(encoding="utf-8")
    _redirect_dashboard_env_writes(monkeypatch, env_path)

    response = dashboard_client.patch(
        "/api/models/current",
        json={"provider": "glm", "model": "glm-5v-turbo"},
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "not selectable in WebUI"
    assert env_path.read_text(encoding="utf-8") == before
    assert runtime_settings.AGENT_LLM_PROVIDER == "kimi_coding"
    assert runtime_settings.AGENT_LLM_MODEL == "kimi-for-coding"

    response = dashboard_client.patch(
        "/api/models/current",
        json={"provider": "deepseek", "model": "deepseek-not-real"},
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "Unsupported model for provider"
    assert env_path.read_text(encoding="utf-8") == before

    response = dashboard_client.patch(
        "/api/models/current",
        json={"provider": "not-a-provider", "model": "whatever"},
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "Unsupported model provider"
    assert env_path.read_text(encoding="utf-8") == before

    monkeypatch.delenv("DEEPSEEK_API", raising=False)
    response = dashboard_client.patch(
        "/api/models/current",
        json={"provider": "deepseek", "model": "deepseek-v4-pro"},
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "missing API key"
    assert env_path.read_text(encoding="utf-8") == before


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


def test_current_model_thinking_patch_updates_deepseek_runtime_and_env(dashboard_client, monkeypatch, tmp_path):
    _configure_deepseek_current_model(monkeypatch, effort="high")
    env_path = tmp_path / ".env"
    env_path.write_text(
        "AGENT_LLM_THINKING_ENABLED=1\n"
        "AGENT_LLM_THINKING_EFFORT=high\n",
        encoding="utf-8",
    )
    _redirect_dashboard_env_writes(monkeypatch, env_path)

    response = dashboard_client.patch("/api/models/current/thinking", json={"level": "max"})

    assert response.status_code == 200
    payload = response.json()
    assert payload["thinking_state"] == {
        "enabled": True,
        "level": "max",
        "editable": True,
    }
    assert runtime_settings.AGENT_LLM_THINKING_ENABLED is True
    assert runtime_settings.AGENT_LLM_THINKING_EFFORT == "max"
    assert os.environ["AGENT_LLM_THINKING_ENABLED"] == "1"
    assert os.environ["AGENT_LLM_THINKING_EFFORT"] == "max"
    assert "AGENT_LLM_THINKING_EFFORT=max\n" in env_path.read_text(encoding="utf-8")

    response = dashboard_client.patch("/api/models/current/thinking", json={"level": "off"})

    assert response.status_code == 200
    payload = response.json()
    assert payload["thinking_state"]["level"] == "off"
    assert payload["thinking_state"]["enabled"] is False
    assert payload["thinking_state"]["editable"] is True
    assert runtime_settings.AGENT_LLM_THINKING_ENABLED is False
    assert runtime_settings.AGENT_LLM_THINKING_EFFORT == "high"
    assert os.environ["AGENT_LLM_THINKING_ENABLED"] == "0"
    assert os.environ["AGENT_LLM_THINKING_EFFORT"] == "high"
    env_text = env_path.read_text(encoding="utf-8")
    assert "AGENT_LLM_THINKING_ENABLED=0\n" in env_text
    assert "AGENT_LLM_THINKING_EFFORT=high\n" in env_text

    response = dashboard_client.patch("/api/models/current/thinking", json={"level": "high"})

    assert response.status_code == 200
    payload = response.json()
    assert payload["thinking_state"] == {
        "enabled": True,
        "level": "high",
        "editable": True,
    }
    assert runtime_settings.AGENT_LLM_THINKING_ENABLED is True
    assert runtime_settings.AGENT_LLM_THINKING_EFFORT == "high"
    assert os.environ["AGENT_LLM_THINKING_ENABLED"] == "1"
    assert os.environ["AGENT_LLM_THINKING_EFFORT"] == "high"


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


def test_current_model_thinking_patch_rejects_deepseek_invalid_level_without_env_write(
    dashboard_client,
    monkeypatch,
    tmp_path,
):
    _configure_deepseek_current_model(monkeypatch, effort="high")
    env_path = tmp_path / ".env"
    env_path.write_text(
        "AGENT_LLM_THINKING_ENABLED=1\n"
        "AGENT_LLM_THINKING_EFFORT=high\n",
        encoding="utf-8",
    )
    before = env_path.read_text(encoding="utf-8")
    _redirect_dashboard_env_writes(monkeypatch, env_path)

    response = dashboard_client.patch("/api/models/current/thinking", json={"level": "low"})

    assert response.status_code == 400
    assert env_path.read_text(encoding="utf-8") == before
    assert runtime_settings.AGENT_LLM_THINKING_ENABLED is True
    assert runtime_settings.AGENT_LLM_THINKING_EFFORT == "high"
    assert os.environ["AGENT_LLM_THINKING_ENABLED"] == "1"
    assert os.environ["AGENT_LLM_THINKING_EFFORT"] == "high"


def test_current_model_thinking_patch_rejects_provider_managed_without_env_write(
    dashboard_client,
    monkeypatch,
    tmp_path,
):
    _configure_glm_current_model(monkeypatch)
    env_path = tmp_path / ".env"
    env_path.write_text(
        "AGENT_LLM_THINKING_ENABLED=1\n"
        "AGENT_LLM_THINKING_EFFORT=high\n",
        encoding="utf-8",
    )
    before = env_path.read_text(encoding="utf-8")
    _redirect_dashboard_env_writes(monkeypatch, env_path)

    response = dashboard_client.patch("/api/models/current/thinking", json={"level": "high"})

    assert response.status_code == 400
    assert response.json()["detail"] == "Current model does not support editable thinking levels"
    assert env_path.read_text(encoding="utf-8") == before
    assert runtime_settings.AGENT_LLM_THINKING_ENABLED is True
    assert runtime_settings.AGENT_LLM_THINKING_EFFORT == "high"


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


def test_skills_endpoint_filters_to_fba_agent_skill_types(dashboard_client, monkeypatch, tmp_path):
    _install_dashboard_filter_skill_root(monkeypatch, tmp_path)
    monkeypatch.setattr(dashboard_api, "FEISHU_APP_ID", BOT_ID_LXE_FBA_AGENT)

    response = dashboard_client.get("/api/skills")

    assert response.status_code == 200
    payload = response.json()
    assert payload["total"] == 2
    assert {item["name"] for item in payload["items"]} == {
        "dashboard-default-skill",
        "dashboard-fba-skill",
    }
    assert {item["type"] for item in payload["items"]} == {
        SKILL_TYPE_DEFAULT,
        SKILL_TYPE_AMAZON_FBA,
    }
    assert all(item["enabled"] is True for item in payload["items"])


def test_skills_endpoint_filters_to_replenish_agent_skill_types(dashboard_client, monkeypatch, tmp_path):
    _install_dashboard_filter_skill_root(monkeypatch, tmp_path)
    monkeypatch.setattr(dashboard_api, "FEISHU_APP_ID", BOT_ID_AMAZON_REPLENISH)

    response = dashboard_client.get("/api/skills")

    assert response.status_code == 200
    payload = response.json()
    assert payload["total"] == 2
    assert {item["name"] for item in payload["items"]} == {
        "dashboard-default-skill",
        "dashboard-replenish-skill",
    }
    assert {item["type"] for item in payload["items"]} == {
        SKILL_TYPE_DEFAULT,
        SKILL_TYPE_AMAZON_REPLENISH,
    }
    assert all(item["enabled"] is True for item in payload["items"])


def test_skills_endpoint_allows_all_for_claw_agent(dashboard_client, monkeypatch, tmp_path):
    _install_dashboard_filter_skill_root(monkeypatch, tmp_path)
    monkeypatch.setattr(dashboard_api, "FEISHU_APP_ID", BOT_ID_LXE_CLAW)

    response = dashboard_client.get("/api/skills")

    assert response.status_code == 200
    payload = response.json()
    assert payload["total"] == 3
    assert {item["name"] for item in payload["items"]} == {
        "dashboard-default-skill",
        "dashboard-fba-skill",
        "dashboard-replenish-skill",
    }
    assert all(item["enabled"] is True for item in payload["items"])


def test_skills_endpoint_returns_empty_for_unknown_agent(dashboard_client, monkeypatch, tmp_path):
    _install_dashboard_filter_skill_root(monkeypatch, tmp_path)
    monkeypatch.setattr(dashboard_api, "FEISHU_APP_ID", "cli_unknown")

    response = dashboard_client.get("/api/skills")

    assert response.status_code == 200
    assert response.json() == {"items": [], "total": 0}


def test_skill_content_endpoint_returns_skill_body(dashboard_client, monkeypatch, tmp_path):
    skill = _install_dashboard_test_skill_root(monkeypatch, tmp_path)

    response = dashboard_client.get(f"/api/skills/{skill['name']}/content")

    assert response.status_code == 200
    payload = response.json()
    assert payload["name"] == skill["name"]
    assert payload["type"] == "dashboard_test"
    assert payload["description"] == "Dashboard skill body fixture."
    assert payload["content"] == skill["skill_text"]
    assert payload["references"] == [
        {"path": "references/example.md", "description": "Example reference"},
    ]
    assert payload["location"].endswith("dashboard-test-skill/SKILL.md")


def test_skill_content_endpoint_returns_404_for_missing_skill(dashboard_client):
    response = dashboard_client.get("/api/skills/not-a-real-skill/content")

    assert response.status_code == 404
    assert response.json()["detail"] == "skill not found"


def test_skill_reference_endpoint_returns_declared_reference(dashboard_client, monkeypatch, tmp_path):
    skill = _install_dashboard_test_skill_root(monkeypatch, tmp_path)

    response = dashboard_client.get(f"/api/skills/{skill['name']}/references/references/example.md")

    assert response.status_code == 200
    payload = response.json()
    assert payload["skill_name"] == skill["name"]
    assert payload["path"] == "references/example.md"
    assert payload["description"] == "Example reference"
    assert payload["content"] == skill["reference_text"]
    assert payload["location"].endswith("dashboard-test-skill/references/example.md")


def test_skill_detail_endpoints_filter_unsupported_skills(dashboard_client, monkeypatch, tmp_path):
    _install_dashboard_filter_skill_root(monkeypatch, tmp_path)
    monkeypatch.setattr(dashboard_api, "FEISHU_APP_ID", BOT_ID_LXE_FBA_AGENT)

    supported_content = dashboard_client.get("/api/skills/dashboard-fba-skill/content")
    supported_reference = dashboard_client.get(
        "/api/skills/dashboard-fba-skill/references/references/example.md"
    )
    unsupported_content = dashboard_client.get("/api/skills/dashboard-replenish-skill/content")
    unsupported_reference = dashboard_client.get(
        "/api/skills/dashboard-replenish-skill/references/references/example.md"
    )

    assert supported_content.status_code == 200
    assert supported_content.json()["name"] == "dashboard-fba-skill"
    assert supported_reference.status_code == 200
    assert supported_reference.json()["skill_name"] == "dashboard-fba-skill"
    assert unsupported_content.status_code == 404
    assert unsupported_content.json()["detail"] == "skill not found"
    assert unsupported_reference.status_code == 404
    assert unsupported_reference.json()["detail"] == "skill not found"


def test_skill_reference_endpoint_rejects_undeclared_or_escaped_paths(dashboard_client, monkeypatch, tmp_path):
    skill = _install_dashboard_test_skill_root(monkeypatch, tmp_path)

    undeclared = dashboard_client.get(f"/api/skills/{skill['name']}/references/references/secret.md")
    escaped = dashboard_client.get(f"/api/skills/{skill['name']}/references/%2E%2E/SKILL.md")

    assert undeclared.status_code == 404
    assert undeclared.json()["detail"] == "skill reference not found"
    assert escaped.status_code == 404
    assert escaped.json()["detail"] == "skill reference not found"
