from __future__ import annotations

import json
from pathlib import Path

from shared.agent_state import CONTEXT_KEY, RUNTIME_KEY
from shared.db.sqlite.agent_sessions import create_agent_session, update_agent_session
from shared.db.sqlite.bootstrap import init_schema
from shared.telemetry.client import upload_snapshot
from shared.telemetry.identity import load_or_create_machine_id
from shared.telemetry.snapshot import build_telemetry_snapshot
from shared.telemetry.sync import sync_once


def _state(messages: list[dict] | None = None) -> dict:
    return {
        RUNTIME_KEY: {},
        CONTEXT_KEY: {"messages": list(messages or [])},
    }


def _source() -> dict:
    return {
        "platform": "feishu",
        "chat_id": "chat-1",
        "chat_type": "group",
        "user_id": "ou_user",
        "user_id_alt": "on_union",
        "user_name": "测试用户",
        "extra": {
            "bot_app_id": "cli_a",
            "bot_id": "ou_bot_1",
            "bot_name": "FBA Assistant",
        },
    }


def _init_sqlite(monkeypatch, tmp_path: Path) -> Path:
    db_path = tmp_path / "local_agent.sqlite3"
    monkeypatch.setenv("LXE_SQLITE_DB_PATH", str(db_path))
    monkeypatch.setenv("AGENT_SESSION_BINDINGS_PATH", str(tmp_path / "sessions.json"))
    init_schema()
    return db_path


def test_machine_id_is_created_and_reused(tmp_path):
    identity_path = tmp_path / "machine_identity.json"

    first = load_or_create_machine_id(identity_path)
    second = load_or_create_machine_id(identity_path)
    payload = json.loads(identity_path.read_text(encoding="utf-8"))

    assert first
    assert second == first
    assert payload["machine_id"] == first
    assert payload["hostname_at_creation"]


def test_build_snapshot_includes_sessions_messages_and_source_extra(monkeypatch, tmp_path):
    _init_sqlite(monkeypatch, tmp_path)
    created = create_agent_session(
        session_id="session-1",
        source=_source(),
        state_data=_state([{"role": "user", "content": "hello"}]),
        model="kimi-coding",
        model_config={"provider": "kimi_coding"},
        title="hello",
    )
    update_agent_session(
        created.session_id,
        metrics_delta={
            "input_tokens": 10,
            "output_tokens": 6,
            "api_call_count": 1,
            "tool_call_count": 2,
        },
    )

    snapshot = build_telemetry_snapshot(
        machine_id="machine-1",
        gateway_id="gateway-1",
    )

    assert snapshot["machine_id"] == "machine-1"
    assert snapshot["gateway_id"] == "gateway-1"
    session = snapshot["sessions"][0]
    assert session["session_id"] == "session-1"
    assert session["source"]["extra"]["bot_name"] == "FBA Assistant"
    assert session["input_tokens"] == 10
    assert session["output_tokens"] == 6
    assert session["api_call_count"] == 1
    assert session["tool_call_count"] == 2
    assert session["messages"] == [{"role": "user", "content": "hello"}]


def test_upload_snapshot_uses_bearer_token(monkeypatch):
    calls: list[dict] = []

    class FakeResponse:
        def raise_for_status(self) -> None:
            return None

        def json(self):
            return {"status": "ok", "sessions_received": 1, "messages_received": 2}

    class FakeSession:
        def post(self, url, **kwargs):
            calls.append({"url": url, **kwargs})
            return FakeResponse()

    monkeypatch.setattr("shared.telemetry.client.local_service_requests_session", FakeSession())

    response = upload_snapshot(
        server_url="http://127.0.0.1:8000/",
        api_key="secret-token",
        snapshot={"machine_id": "machine-1", "sessions": []},
        timeout_s=5,
    )

    assert response["sessions_received"] == 1
    assert calls[0]["url"] == "http://127.0.0.1:8000/api/v1/telemetry/snapshot"
    assert calls[0]["headers"] == {"Authorization": "Bearer secret-token"}
    assert calls[0]["timeout"] == 5


def test_sync_once_builds_and_uploads_snapshot(monkeypatch, tmp_path):
    _init_sqlite(monkeypatch, tmp_path)
    monkeypatch.setenv("TELEMETRY_ENABLED", "1")
    monkeypatch.setenv("TELEMETRY_SERVER_URL", "http://127.0.0.1:8000")
    monkeypatch.setenv("TELEMETRY_API_KEY", "secret-token")
    monkeypatch.setenv("TELEMETRY_MACHINE_ID_PATH", str(tmp_path / "machine_identity.json"))
    create_agent_session(
        session_id="session-1",
        source=_source(),
        state_data=_state([{"role": "user", "content": "hello"}]),
    )
    uploads: list[dict] = []

    def fake_upload_snapshot(**kwargs):
        uploads.append(kwargs)
        return {"sessions_received": 1, "messages_received": 1}

    monkeypatch.setattr("shared.telemetry.sync.upload_snapshot", fake_upload_snapshot)

    result = sync_once(gateway_id="gateway-1")

    assert result.uploaded is True
    assert result.sessions_received == 1
    assert result.messages_received == 1
    assert uploads[0]["server_url"] == "http://127.0.0.1:8000"
    assert uploads[0]["api_key"] == "secret-token"
    assert uploads[0]["snapshot"]["gateway_id"] == "gateway-1"
    assert uploads[0]["snapshot"]["sessions"][0]["source"]["extra"]["bot_id"] == "ou_bot_1"


def test_sync_once_skips_when_enabled_but_config_missing(monkeypatch):
    monkeypatch.setenv("TELEMETRY_ENABLED", "1")
    monkeypatch.delenv("TELEMETRY_SERVER_URL", raising=False)
    monkeypatch.delenv("TELEMETRY_API_KEY", raising=False)

    result = sync_once(gateway_id="gateway-1")

    assert result.uploaded is False
    assert result.skipped_reason == "missing_config"


def test_sync_once_upload_failure_is_non_fatal(monkeypatch, tmp_path):
    _init_sqlite(monkeypatch, tmp_path)
    monkeypatch.setenv("TELEMETRY_ENABLED", "1")
    monkeypatch.setenv("TELEMETRY_SERVER_URL", "http://127.0.0.1:1")
    monkeypatch.setenv("TELEMETRY_API_KEY", "secret-token")
    monkeypatch.setenv("TELEMETRY_MACHINE_ID_PATH", str(tmp_path / "machine_identity.json"))
    create_agent_session(
        session_id="session-1",
        source=_source(),
        state_data=_state([{"role": "user", "content": "hello"}]),
    )

    def fake_upload_snapshot(**_kwargs):
        raise RuntimeError("server unavailable")

    monkeypatch.setattr("shared.telemetry.sync.upload_snapshot", fake_upload_snapshot)

    result = sync_once(gateway_id="gateway-1")

    assert result.uploaded is False
    assert result.skipped_reason == "upload_failed"
