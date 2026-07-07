"""Guards for the light persistence paths: no transcript replay on hot paths.

Batch-1 performance contract:
- load_agent_session_record loads metadata without replaying the transcript.
- Write paths with include_state=False skip the full state rebuild.
- The turn cancellation check is purely in-memory (never touches the DB).
"""
from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

import pytest

import agent_runtime.turn_handler as turn_handler_mod
import shared.db.sqlite.agent_sessions as agent_sessions_mod
from agent_runtime.turn_handler import handle_unified_turn_job
from agent_runtime.types import TurnOutcome
from shared.agent_state import CONTEXT_KEY, MESSAGES_KEY, RUNTIME_KEY
from shared.db import client as shared_db_client
from shared.db.sqlite.agent_sessions import (
    append_agent_session_context_replacement,
    append_agent_session_message,
    create_agent_session,
    load_agent_session_record,
    update_agent_session,
)
from shared.db.sqlite.bootstrap import init_schema
from shared.db.sqlite.session_transcripts import replay_transcript_model_context


@pytest.fixture()
def sqlite_db(monkeypatch, tmp_path):
    monkeypatch.setenv("LXE_SQLITE_DB_PATH", str(tmp_path / "local_agent.sqlite3"))
    monkeypatch.setenv("AGENT_SESSION_BINDINGS_PATH", str(tmp_path / "sessions.json"))
    init_schema()
    return tmp_path / "local_agent.sqlite3"


def _state(messages: list[dict[str, Any]]) -> dict[str, Any]:
    return {RUNTIME_KEY: {}, CONTEXT_KEY: {MESSAGES_KEY: messages}}


def _forbid_transcript_replay(monkeypatch) -> None:
    def _boom(*_args: Any, **_kwargs: Any) -> Any:
        raise AssertionError("transcript replay must not run on a light path")

    monkeypatch.setattr(agent_sessions_mod, "replay_transcript_model_context", _boom)
    monkeypatch.setattr(agent_sessions_mod, "ensure_transcript_seeded_from_legacy_messages", _boom)


def test_load_agent_session_record_skips_transcript_replay(sqlite_db, monkeypatch) -> None:
    created = create_agent_session(
        source={"platform": "feishu"},
        state_data=_state([{"role": "user", "content": "hello"}]),
        session_id="session-light",
    )
    assert created.message_count == 1

    _forbid_transcript_replay(monkeypatch)

    record = load_agent_session_record("session-light")
    assert record is not None
    assert record.session_id == "session-light"
    assert record.source == {"platform": "feishu"}
    assert record.message_count == 1
    assert not hasattr(record, "state_data")

    assert load_agent_session_record("missing-session") is None
    assert load_agent_session_record("") is None


def test_write_paths_skip_state_rebuild_with_include_state_false(sqlite_db, monkeypatch) -> None:
    create_agent_session(
        source={"platform": "feishu"},
        state_data=_state([{"role": "user", "content": "hello"}]),
        session_id="session-write",
    )

    _forbid_transcript_replay(monkeypatch)

    assert (
        append_agent_session_message(
            "session-write",
            {"role": "assistant", "content": "ok"},
            include_state=False,
        )
        is None
    )
    assert (
        update_agent_session(
            "session-write",
            metrics_delta={"input_tokens": 5},
            include_state=False,
        )
        is None
    )

    # Writes landed even though no state was rebuilt.
    record = load_agent_session_record("session-write")
    assert record is not None
    assert record.message_count == 2
    assert record.input_tokens == 5
    assert replay_transcript_model_context("session-write") == [
        {"role": "user", "content": "hello"},
        {"role": "assistant", "content": [{"type": "text", "text": "ok"}]},
    ]

    assert (
        append_agent_session_context_replacement(
            "session-write",
            replacement_history=[{"role": "user", "content": "kept"}],
            replacement_kind="repair",
            reason="test",
            include_state=False,
        )
        is None
    )
    assert replay_transcript_model_context("session-write") == [
        {"role": "user", "content": "kept"},
    ]


def test_async_client_append_paths_are_write_only(sqlite_db, monkeypatch) -> None:
    create_agent_session(
        source={"platform": "feishu"},
        state_data=_state([]),
        session_id="session-async",
    )

    _forbid_transcript_replay(monkeypatch)

    async def _run() -> None:
        assert (
            await shared_db_client.append_agent_session_message(
                "session-async",
                {"role": "user", "content": "hi"},
            )
            is None
        )
        assert (
            await shared_db_client.append_agent_session_context_replacement(
                "session-async",
                replacement_history=[],
                replacement_kind="repair",
                reason="test",
            )
            is None
        )

    asyncio.run(_run())


def _job() -> SimpleNamespace:
    return SimpleNamespace(
        job_id="job-1",
        payload={
            "session_id": "session-1",
            "response_route_id": "route-1",
            "session_key": "key-1",
            "job_id": "job-1",
            "job_kind": "turn",
            "user_text": "hello",
            "raw_data": {},
            "source": {"platform": "feishu"},
            "user_content_blocks": [],
        },
    )


def _patch_turn_handler(monkeypatch, db_calls: list[str], *, expected_cancelled: bool) -> None:
    session = SimpleNamespace(
        session_id="session-1",
        source={"platform": "feishu"},
        state_data={},
        owner_user_id="user-1",
    )

    async def fake_load_agent_session(session_id: str) -> SimpleNamespace:
        db_calls.append("load")
        return session

    async def fake_load_agent_session_record(session_id: str) -> SimpleNamespace:
        db_calls.append("record")
        return session

    async def fake_update_agent_session(*_args: Any, **_kwargs: Any) -> None:
        db_calls.append("update")

    async def fake_run_turn(**kwargs: Any) -> TurnOutcome:
        cancellation_check = kwargs["cancellation_check"]
        for _ in range(50):
            assert await cancellation_check() is expected_cancelled
        return TurnOutcome(status="done", reply="answer", state_data_patch={})

    monkeypatch.setattr(turn_handler_mod, "load_agent_session", fake_load_agent_session)
    monkeypatch.setattr(turn_handler_mod, "load_agent_session_record", fake_load_agent_session_record)
    monkeypatch.setattr(turn_handler_mod, "update_agent_session", fake_update_agent_session)
    monkeypatch.setattr(turn_handler_mod, "run_turn", fake_run_turn)
    monkeypatch.setattr(turn_handler_mod, "_should_stream_final_answer", lambda _session: False)


def test_cancellation_check_never_touches_db(monkeypatch) -> None:
    db_calls: list[str] = []
    _patch_turn_handler(monkeypatch, db_calls, expected_cancelled=False)

    async def emit_final(**_kwargs: Any) -> None:
        pass

    asyncio.run(handle_unified_turn_job(_job(), emit_final=emit_final))

    # Exactly one full load (turn start), one record load (persist existence
    # check), one update (persist) — the 50 cancellation checks add nothing.
    assert db_calls == ["load", "record", "update"]


def test_cancellation_check_reflects_run_handle(monkeypatch) -> None:
    db_calls: list[str] = []
    _patch_turn_handler(monkeypatch, db_calls, expected_cancelled=True)

    async def emit_final(**_kwargs: Any) -> None:
        pass

    run_handle = SimpleNamespace(cancelled=True)
    asyncio.run(handle_unified_turn_job(_job(), run_handle=run_handle, emit_final=emit_final))

    assert db_calls == ["load", "record", "update"]
