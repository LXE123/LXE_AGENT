"""Transcript replay cache: cache hits skip file parsing, writes keep it fresh,
and any out-of-band file change invalidates via the stat signature."""
from __future__ import annotations

from typing import Any

import pytest

import shared.db.sqlite.session_transcripts as session_transcripts_mod
from shared.agent_state import CONTEXT_KEY, MESSAGES_KEY, RUNTIME_KEY
from shared.db.sqlite.agent_sessions import create_agent_session, load_agent_session
from shared.db.sqlite.bootstrap import init_schema
from shared.db.sqlite.session_transcripts import (
    append_transcript_message,
    append_transcript_replacement,
    clear_transcript_replay_cache,
    replay_transcript_model_context,
    session_transcript_path,
)


@pytest.fixture()
def sqlite_db(monkeypatch, tmp_path):
    monkeypatch.setenv("LXE_SQLITE_DB_PATH", str(tmp_path / "local_agent.sqlite3"))
    monkeypatch.setenv("AGENT_SESSION_BINDINGS_PATH", str(tmp_path / "sessions.json"))
    init_schema()
    clear_transcript_replay_cache()
    yield tmp_path / "local_agent.sqlite3"
    clear_transcript_replay_cache()


def _forbid_file_read(monkeypatch) -> None:
    def _boom(*_args: Any, **_kwargs: Any) -> Any:
        raise AssertionError("transcript file must not be re-parsed on a cache hit")

    monkeypatch.setattr(session_transcripts_mod, "load_transcript_events", _boom)


def test_replay_is_served_from_cache_after_first_read(sqlite_db, monkeypatch) -> None:
    append_transcript_message("session-cache", {"role": "user", "content": "hello"})
    first = replay_transcript_model_context("session-cache")
    assert first == [{"role": "user", "content": "hello"}]

    _forbid_file_read(monkeypatch)
    assert replay_transcript_model_context("session-cache") == first


def test_append_keeps_cache_fresh_without_file_read(sqlite_db, monkeypatch) -> None:
    append_transcript_message("session-fresh", {"role": "user", "content": "hello"})
    replay_transcript_model_context("session-fresh")

    _forbid_file_read(monkeypatch)
    append_transcript_message("session-fresh", {"role": "assistant", "content": "ok"})
    assert replay_transcript_model_context("session-fresh") == [
        {"role": "user", "content": "hello"},
        {"role": "assistant", "content": [{"type": "text", "text": "ok"}]},
    ]


def test_replacement_swaps_cached_context(sqlite_db, monkeypatch) -> None:
    append_transcript_message("session-swap", {"role": "user", "content": "old"})
    replay_transcript_model_context("session-swap")

    _forbid_file_read(monkeypatch)
    append_transcript_replacement(
        "session-swap",
        replacement_history=[{"role": "user", "content": "kept"}],
        replacement_kind="compaction",
        summary_text="summary",
        compacted_count=1,
        trigger="post_turn",
    )
    assert replay_transcript_model_context("session-swap") == [
        {"role": "user", "content": "kept"},
    ]


def test_external_file_write_invalidates_cache(sqlite_db) -> None:
    append_transcript_message("session-external", {"role": "user", "content": "hello"})
    replay_transcript_model_context("session-external")

    # Bypass _append_event, as an external process or manual edit would.
    path = session_transcript_path("session-external")
    with path.open("a", encoding="utf-8", newline="\n") as handle:
        handle.write('{"ts":1.0,"kind":"message","reason":"","message":{"role":"user","content":"outside"}}\n')

    assert replay_transcript_model_context("session-external") == [
        {"role": "user", "content": "hello"},
        {"role": "user", "content": "outside"},
    ]


def test_file_deletion_drops_cache_entry(sqlite_db) -> None:
    append_transcript_message("session-gone", {"role": "user", "content": "hello"})
    assert replay_transcript_model_context("session-gone")

    session_transcript_path("session-gone").unlink()
    assert replay_transcript_model_context("session-gone") == []


def test_returned_list_is_isolated_from_cache(sqlite_db) -> None:
    append_transcript_message("session-isolate", {"role": "user", "content": "hello"})
    first = replay_transcript_model_context("session-isolate")
    first.append({"role": "user", "content": "injected"})

    assert replay_transcript_model_context("session-isolate") == [
        {"role": "user", "content": "hello"},
    ]


def test_load_agent_session_uses_replay_cache(sqlite_db, monkeypatch) -> None:
    create_agent_session(
        source={"platform": "feishu"},
        state_data={RUNTIME_KEY: {}, CONTEXT_KEY: {MESSAGES_KEY: [{"role": "user", "content": "hello"}]}},
        session_id="session-load",
    )
    warm = load_agent_session("session-load")
    assert warm is not None

    _forbid_file_read(monkeypatch)
    cached = load_agent_session("session-load")
    assert cached is not None
    assert cached.state_data[CONTEXT_KEY][MESSAGES_KEY] == [
        {"role": "user", "content": "hello"},
    ]
