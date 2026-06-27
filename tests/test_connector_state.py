from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

from agent_runtime.runtime import load_available_skills_for_session
from shared.connector_state import (
    LARK_CLI_SKILL_NAMES,
    connector_payloads,
    load_connector_state,
    set_connector_enabled,
)
from shared.permission_policy import BOT_ID_LXE_CLAW


def test_connector_state_defaults_disabled_without_state_file(monkeypatch, tmp_path: Path) -> None:
    state_path = tmp_path / "connector-states.local.json"
    monkeypatch.setenv("LXE_CONNECTOR_STATE_PATH", str(state_path))

    state = load_connector_state()
    connectors = {item["id"]: item for item in connector_payloads()}

    assert state["enabled"] == []
    assert state["everConnected"] == []
    assert state["userDisabled"] == []
    assert connectors["feishu"]["enabled"] is False
    assert connectors["feishu"]["everConnected"] is False
    assert connectors["feishu"]["userDisabled"] is False
    assert connectors["feishu"]["skill_count"] == len(LARK_CLI_SKILL_NAMES)
    assert connectors["dingtalk"]["enabled"] is False
    assert connectors["dingtalk"]["skill_names"] == ["dws"]
    assert not state_path.exists()


def test_connector_state_disable_and_reenable_writes_local_json(monkeypatch, tmp_path: Path) -> None:
    state_path = tmp_path / "connector-states.local.json"
    monkeypatch.setenv("LXE_CONNECTOR_STATE_PATH", str(state_path))

    disabled = set_connector_enabled("feishu", False)

    assert disabled["enabled"] is False
    saved = json.loads(state_path.read_text(encoding="utf-8"))
    assert "feishu" not in saved["enabled"]
    assert "feishu" in saved["userDisabled"]

    enabled = set_connector_enabled("feishu", True)

    assert enabled["enabled"] is True
    saved = json.loads(state_path.read_text(encoding="utf-8"))
    assert "feishu" in saved["enabled"]
    assert "feishu" in saved["everConnected"]
    assert "feishu" not in saved["userDisabled"]


def test_load_available_skills_filters_disabled_connector_skills(monkeypatch, tmp_path: Path) -> None:
    state_path = tmp_path / "connector-states.local.json"
    monkeypatch.setenv("LXE_CONNECTOR_STATE_PATH", str(state_path))

    session = SimpleNamespace(platform="feishu", raw_data={"app_id": BOT_ID_LXE_CLAW})
    skill_names = {item.name for item in load_available_skills_for_session(session)}

    assert not any(name.startswith("lark-") for name in skill_names)
    assert "dws" not in skill_names
    assert "feishu-im-read" in skill_names
