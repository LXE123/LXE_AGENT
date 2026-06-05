from __future__ import annotations

import asyncio
import json
import sqlite3
import sys
from types import SimpleNamespace

import pytest

from agent_runtime.tools.process_sessions import (
    SessionStatus,
    clear_exec_sessions_for_tests,
    get_exec_session_registry,
    process_exec_session,
)
from agent_runtime.turn_handler import handle_unified_turn_job
from gateway.heartbeat_wake import HeartbeatWakeManager
from shared.agent_sessions import AgentSessionStatus
from shared.agent_state import CONTEXT_KEY, RUNTIME_KEY
from shared.db import client as shared_db_client
from shared.db.sqlite.agent_sessions import (
    append_agent_session_pending_event,
    cancel_agent_session,
    clear_agent_session_memory,
    create_agent_session,
    discard_agent_session_pending_event,
    has_agent_session_pending_events,
    load_agent_session,
    pop_agent_session_pending_events,
    reset_agent_session_context,
    update_agent_session,
)
from shared.db.sqlite.bootstrap import init_schema
from shared.db.sqlite.card_state import (
    create_context,
    load_context,
    save_delivery_handle,
    save_session_patch,
    touch,
)
from shared.db.sqlite.engine import connect
from shared.db.sqlite.session_messages import load_session_messages, save_session_messages, session_messages_path
from shared.db.sqlite.store_sessions import (
    clear_store_sessions,
    delete_store_session,
    list_store_sessions,
    load_store_session,
    upsert_store_session,
)
from shared.session_bindings import SessionBindingStore, SessionSource


@pytest.fixture()
def sqlite_db(monkeypatch, tmp_path):
    monkeypatch.setenv("LXE_SQLITE_DB_PATH", str(tmp_path / "local_agent.sqlite3"))
    monkeypatch.setenv("AGENT_SESSION_BINDINGS_PATH", str(tmp_path / "sessions.json"))
    init_schema()
    return tmp_path / "local_agent.sqlite3"


def _ctx(**overrides):
    values = {
        "card_id": "card-1",
        "user_id": "user-1",
        "platform": "feishu",
        "conversation_id": "chat-1",
        "is_group": True,
        "sender_nick": "测试用户",
        "message_id": "msg-1",
        "raw_data": {
            "platform": "feishu",
            "message_id": "msg-1",
        },
    }
    values.update(overrides)
    return SimpleNamespace(**values)


def _source(
    *,
    chat_id: str = "chat-1",
    chat_type: str = "group",
    user_id: str = "ou_user",
    user_id_alt: str = "on_union",
    user_name: str = "测试用户",
    thread_id: str = "",
) -> dict:
    return {
        "platform": "feishu",
        "chat_id": chat_id,
        "chat_type": chat_type,
        "user_id": user_id,
        "user_id_alt": user_id_alt,
        "user_name": user_name,
        **({"thread_id": thread_id} if thread_id else {}),
    }


def _state(messages: list[dict] | None = None, runtime: dict | None = None) -> dict:
    return {
        RUNTIME_KEY: dict(runtime or {}),
        CONTEXT_KEY: {"messages": list(messages or [])},
    }


def _create_session(
    session_id: str,
    *,
    source: dict | None = None,
    status: str = AgentSessionStatus.WAITING_USER_INPUT,
    state_data: dict | None = None,
):
    return create_agent_session(
        session_id=session_id,
        source=source or _source(),
        status=status,
        state_data=state_data or _state(),
    )


def test_card_context_create_patch_delivery_and_touch(sqlite_db):
    create_context(_ctx())

    loaded = load_context("card-1")
    assert loaded is not None
    assert loaded.owner_user_id == "user-1"
    assert loaded.platform == "feishu"
    assert loaded.conversation_type == "2"
    assert loaded.sender_nick == "测试用户"
    assert loaded.extra_data["source_message_id"] == "msg-1"
    assert loaded.created_at is not None
    assert loaded.updated_at is not None

    save_session_patch(
        "card-1",
        {
            "cardkit_card_id": "cardkit-1",
            "cardkit_emit_id": "emit-1",
            "platform_message_id": "pm-1",
            "中文": "值",
        },
    )
    assert save_delivery_handle(
        "card-1",
        platform="feishu",
        platform_message_id="pm-2",
    )
    assert touch("card-1")

    reloaded = load_context("card-1")
    assert reloaded is not None
    assert reloaded.platform_message_id == "pm-2"
    assert reloaded.extra_data["cardkit_card_id"] == "cardkit-1"
    assert reloaded.extra_data["cardkit_emit_id"] == "emit-1"
    assert reloaded.extra_data["中文"] == "值"
    assert reloaded.extra_data["platform"] == "feishu"


def test_public_card_client_uses_sqlite_backend(sqlite_db):
    asyncio.run(shared_db_client.create_card_context(_ctx(card_id="public-card")))
    loaded = asyncio.run(shared_db_client.load_card_context("public-card"))
    assert loaded is not None
    assert loaded.out_track_id == "public-card"

    asyncio.run(shared_db_client.save_card_session_patch("public-card", {"cardkit_emit_id": "emit-public"}))
    patched = asyncio.run(shared_db_client.load_card_session("public-card"))
    assert patched["cardkit_emit_id"] == "emit-public"


def test_card_context_extra_data_must_be_json_object(sqlite_db):
    conn = connect()
    try:
        conn.execute(
            """
            INSERT INTO card_owners (
                out_track_id,
                owner_user_id,
                platform,
                extra_data,
                created_at,
                updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                "bad-card",
                "user-1",
                "feishu",
                json.dumps(["not-object"]),
                "2026-01-01T00:00:00+00:00",
                "2026-01-01T00:00:00+00:00",
            ),
        )
        conn.commit()
    finally:
        conn.close()

    with pytest.raises(RuntimeError, match="extra_data must be a JSON object"):
        load_context("bad-card")


def test_session_source_key_rules() -> None:
    assert SessionSource(
        platform="feishu",
        chat_id="oc_dm",
        chat_type="p2p",
        user_id="ou_user",
        user_id_alt="on_union",
    ).session_key == "agent:main:feishu:dm:oc_dm"
    assert SessionSource(
        platform="feishu",
        chat_id="oc_group",
        chat_type="group",
        user_id="ou_user",
        user_id_alt="on_union",
    ).session_key == "agent:main:feishu:group:oc_group:on_union"
    assert SessionSource(
        platform="feishu",
        chat_id="oc_group",
        chat_type="group",
        user_id="ou_user",
    ).session_key == "agent:main:feishu:group:oc_group:ou_user"
    assert SessionSource(
        platform="feishu",
        chat_id="oc_group",
        chat_type="group",
        user_id="ou_user",
        user_id_alt="on_union",
        thread_id="omt_thread",
    ).session_key == "agent:main:feishu:group:oc_group:omt_thread"


def test_session_binding_store_reuse_rotate_and_restore(sqlite_db, tmp_path):
    store_path = tmp_path / "bindings.json"
    store = SessionBindingStore(store_path)
    source = SessionSource.from_dict(_source(chat_id="oc_group", chat_type="group"))

    first = store.get_or_create(source)
    second = store.get_or_create(source)
    assert second.session_id == first.session_id

    rotated = store.rotate(source)
    assert rotated.session_id != first.session_id
    assert store.get(source.session_key).session_id == rotated.session_id

    restored = SessionBindingStore(store_path).get(source.session_key)
    assert restored is not None
    assert restored.session_id == rotated.session_id


def test_ziniao_store_session_crud_and_upsert(sqlite_db):
    first = upsert_store_session(
        browser_oauth="store-1",
        browser_id=100,
        browser_name="店铺一",
        debugging_port=9222,
        download_path="D:/downloads/one",
        browser_path="D:/browser/one.exe",
        host_id="host-a",
    )
    assert first.browser_id == 100

    second = upsert_store_session(
        browser_oauth="store-1",
        browser_id=101,
        browser_name="店铺一新",
        debugging_port=9333,
        download_path="D:/downloads/two",
        browser_path="D:/browser/two.exe",
        host_id="host-a",
    )
    assert second.browser_id == 101
    assert second.browser_name == "店铺一新"

    items = list_store_sessions(host_id="host-a")
    assert len(items) == 1
    loaded = load_store_session("store-1", host_id="host-a")
    assert loaded is not None
    assert loaded.debugging_port == 9333

    assert delete_store_session("store-1", host_id="host-a")
    assert load_store_session("store-1", host_id="host-a") is None


def test_ziniao_store_session_validation_and_clear(sqlite_db):
    with pytest.raises(RuntimeError, match="browser_id required"):
        upsert_store_session(
            browser_oauth="store-1",
            browser_id=0,
            browser_name="",
            debugging_port=9222,
            download_path="D:/downloads",
            browser_path="D:/browser.exe",
            host_id="host-a",
        )

    upsert_store_session(
        browser_oauth="store-1",
        browser_id=1,
        browser_name="store-1",
        debugging_port=9222,
        download_path="D:/downloads",
        browser_path="D:/browser.exe",
        host_id="host-a",
    )
    assert clear_store_sessions(host_id="host-a") == 1
    assert list_store_sessions(host_id="host-a") == []


def test_session_message_jsonl_create_load_and_update(sqlite_db):
    assert load_session_messages("missing-session") == []

    created = _create_session(
        "session-context",
        state_data=_state([{"role": "user", "content": "hello"}]),
    )
    path = session_messages_path(created.session_id)
    assert path.is_file()
    assert load_session_messages(created.session_id)[0]["content"] == "hello"

    updated = update_agent_session(
        created.session_id,
        state_data_patch={CONTEXT_KEY: {"messages": [{"role": "assistant", "content": "ok"}]}},
    )
    assert updated is not None
    assert updated.state_data[CONTEXT_KEY]["messages"][0]["role"] == "assistant"
    assert load_session_messages(created.session_id)[0]["content"][0]["text"] == "ok"

    save_session_messages(created.session_id, [{"role": "not-a-role", "content": "ignored"}])
    assert load_session_messages(created.session_id) == []


def test_agent_session_create_update_and_source(sqlite_db):
    created = _create_session(
        "session-1",
        source=_source(chat_id="chat-1", chat_type="group"),
        state_data=_state(
            [{"role": "user", "content": "hello"}],
            runtime={"session_activity_at": 1},
        ),
    )
    assert created.session_id == "session-1"
    assert created.source["platform"] == "feishu"
    assert created.source["chat_id"] == "chat-1"
    assert int(created.state_data[RUNTIME_KEY]["session_activity_at"]) > 0
    assert created.state_data[CONTEXT_KEY]["messages"][0]["content"] == "hello"

    conn = connect()
    try:
        session_columns = {
            row["name"]
            for row in conn.execute("PRAGMA table_info(agent_sessions)").fetchall()
        }
        session_row = conn.execute(
            "SELECT source, state_data FROM agent_sessions WHERE session_id = ?",
            ("session-1",),
        ).fetchone()
        agent_contexts_exists = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_contexts'"
        ).fetchone()
    finally:
        conn.close()
    assert "source" in session_columns
    assert "context_id" not in session_columns
    assert "pending_events" not in session_columns
    assert "card_id" not in session_columns
    assert session_row is not None
    assert agent_contexts_exists is None
    assert json.loads(session_row["source"])["chat_id"] == "chat-1"
    assert CONTEXT_KEY not in json.loads(session_row["state_data"])
    assert load_session_messages("session-1")[0]["content"] == "hello"

    updated = update_agent_session(
        "session-1",
        source=_source(chat_id="chat-2", chat_type="group", thread_id="thread-1"),
        status=AgentSessionStatus.WAITING_USER_INPUT,
        state_data_patch={
            RUNTIME_KEY: {
                "session_activity_at": 2,
                "active_turn_id": "legacy-turn",
                "active_card_id": "legacy-card",
                "active_turn_started_at": 123,
            },
            CONTEXT_KEY: {"messages": [{"role": "assistant", "content": "running"}]},
        },
    )
    assert updated is not None
    assert updated.status == AgentSessionStatus.WAITING_USER_INPUT
    assert updated.source["chat_id"] == "chat-2"
    assert updated.source["thread_id"] == "thread-1"
    assert updated.state_data[RUNTIME_KEY]["session_activity_at"] == 2
    assert "active_turn_id" not in updated.state_data[RUNTIME_KEY]
    assert "active_card_id" not in updated.state_data[RUNTIME_KEY]
    assert "active_turn_started_at" not in updated.state_data[RUNTIME_KEY]
    assert updated.state_data[CONTEXT_KEY]["messages"][0]["content"][0]["text"] == "running"
    assert load_agent_session("session-1").session_id == "session-1"

    second = _create_session("session-2", source=_source(chat_id="chat-1", chat_type="group"))
    assert second.session_id == "session-2"


def test_agent_session_pending_events_append_and_pop(sqlite_db):
    _create_session("session-events")

    append_agent_session_pending_event(
        "session-events",
        {"event_id": "event-1", "job_id": "job-1", "created_at": 1, "text": "first"},
    )
    append_agent_session_pending_event(
        "session-events",
        {"event_id": "event-2", "job_id": "job-2", "created_at": 2, "text": "second"},
    )

    conn = connect()
    try:
        stored = conn.execute(
            """
            SELECT event_id, job_id, created_at, text
            FROM agent_session_pending_events
            WHERE session_id = ?
            ORDER BY queue_id ASC
            """,
            ("session-events",),
        ).fetchall()
    finally:
        conn.close()
    assert [row["event_id"] for row in stored] == ["event-1", "event-2"]
    assert [row["created_at"] for row in stored] == ["1", "2"]

    popped = pop_agent_session_pending_events("session-events")
    assert [item["event_id"] for item in popped] == ["event-1", "event-2"]
    assert pop_agent_session_pending_events("session-events") == []


def test_agent_session_pending_events_survive_session_writes(sqlite_db):
    operations = [
        (
            "update",
            lambda session_id: update_agent_session(
                session_id,
                state_data_patch={RUNTIME_KEY: {"session_activity_at": 3}},
            ),
        ),
        ("clear", lambda session_id: clear_agent_session_memory(session_id)),
        ("reset", lambda session_id: reset_agent_session_context(session_id)),
        ("cancel", lambda session_id: cancel_agent_session(session_id)),
    ]

    for operation_name, operation in operations:
        session_id = f"session-preserve-{operation_name}"
        event_id = f"event-preserve-{operation_name}"
        _create_session(
            session_id,
            state_data=_state([{"role": "user", "content": "keep event"}]),
        )
        append_agent_session_pending_event(
            session_id,
            {
                "event_id": event_id,
                "job_id": f"job-preserve-{operation_name}",
                "created_at": 100,
                "text": f"pending after {operation_name}",
            },
        )

        assert operation(session_id) is not None
        popped = pop_agent_session_pending_events(session_id)
        assert [item["event_id"] for item in popped] == [event_id]


def test_agent_session_pending_events_limits_duplicates_and_missing_session(sqlite_db):
    assert append_agent_session_pending_event(
        "missing-session",
        {"event_id": "event-missing", "job_id": "job-missing", "created_at": 1, "text": "missing"},
    ) is None
    assert pop_agent_session_pending_events("missing-session") == []

    _create_session("session-duplicate-event")
    append_agent_session_pending_event(
        "session-duplicate-event",
        {"event_id": "event-duplicate", "job_id": "job-1", "created_at": 1, "text": "first"},
    )
    with pytest.raises(sqlite3.IntegrityError, match="UNIQUE"):
        append_agent_session_pending_event(
            "session-duplicate-event",
            {"event_id": "event-duplicate", "job_id": "job-2", "created_at": 2, "text": "second"},
        )

    _create_session("session-full-events")
    for index in range(10):
        append_agent_session_pending_event(
            "session-full-events",
            {
                "event_id": f"event-full-{index}",
                "job_id": f"job-full-{index}",
                "created_at": index + 1,
                "text": f"event {index}",
            },
        )
    with pytest.raises(RuntimeError, match="pending_events queue full"):
        append_agent_session_pending_event(
            "session-full-events",
            {"event_id": "event-full-overflow", "job_id": "job-full-overflow", "created_at": 11, "text": "overflow"},
        )


def test_agent_session_pending_events_discard_and_has(sqlite_db):
    _create_session("session-discard-event")
    append_agent_session_pending_event(
        "session-discard-event",
        {"event_id": "event-discard-1", "job_id": "job-discard-1", "created_at": 1, "text": "first"},
    )
    append_agent_session_pending_event(
        "session-discard-event",
        {"event_id": "event-discard-2", "job_id": "job-discard-2", "created_at": 2, "text": "second"},
    )

    assert has_agent_session_pending_events("session-discard-event") is True
    assert discard_agent_session_pending_event("session-discard-event", "job-discard-1") == 1

    popped = pop_agent_session_pending_events("session-discard-event")
    assert [item["event_id"] for item in popped] == ["event-discard-2"]
    assert has_agent_session_pending_events("session-discard-event") is False
    assert discard_agent_session_pending_event("session-discard-event", "job-missing") == 0


def _create_completed_exec_session(owner_session_id: str):
    session = get_exec_session_registry().create(
        "test command",
        ".",
        owner_session_id=owner_session_id,
        origin_turn_id="turn-current",
    )
    session.status = SessionStatus.COMPLETED
    session.exit_code = 0
    session.stdout = "line 1\nline 2\n"
    session.pending_stdout = "line 2\n"
    session.stdout_tail = session.stdout
    session.ended_at = session.started_at + 1.0
    session.notify_on_exit = True
    session.done_event.set()
    return session


def _append_completion_event(owner_session_id: str, exec_session_id: str) -> None:
    append_agent_session_pending_event(
        owner_session_id,
        {
            "event_id": f"event-{exec_session_id}",
            "job_id": exec_session_id,
            "created_at": 1,
            "text": "background process finished",
        },
    )


def test_process_poll_consumes_terminal_completion(sqlite_db):
    _create_session("session-poll-consume")

    async def _run():
        try:
            session = _create_completed_exec_session("session-poll-consume")
            _append_completion_event("session-poll-consume", session.id)

            payload = await process_exec_session(action="poll", session_id=session.id)

            assert payload["status"] == SessionStatus.COMPLETED.value
            assert payload["exit_code"] == 0
            assert session.completion_consumed is True
            assert session.notify_on_exit is False
            assert pop_agent_session_pending_events("session-poll-consume") == []
        finally:
            await clear_exec_sessions_for_tests()

    asyncio.run(_run())


def test_process_log_consumes_terminal_completion_without_status_payload(sqlite_db):
    _create_session("session-log-consume")

    async def _run():
        try:
            session = _create_completed_exec_session("session-log-consume")
            _append_completion_event("session-log-consume", session.id)

            payload = await process_exec_session(action="log", session_id=session.id)

            assert "status" not in payload
            assert "exit_code" not in payload
            assert payload["output"] == "line 1\nline 2"
            assert session.completion_consumed is True
            assert session.notify_on_exit is False
            assert pop_agent_session_pending_events("session-log-consume") == []
        finally:
            await clear_exec_sessions_for_tests()

    asyncio.run(_run())


def test_process_list_does_not_consume_terminal_completion(sqlite_db):
    _create_session("session-list-no-consume")

    async def _run():
        try:
            session = _create_completed_exec_session("session-list-no-consume")
            _append_completion_event("session-list-no-consume", session.id)

            payload = await process_exec_session(action="list")

            assert any(item["session"] == session.id for item in payload["sessions"])
            assert session.completion_consumed is False
            popped = pop_agent_session_pending_events("session-list-no-consume")
            assert [item["job_id"] for item in popped] == [session.id]
        finally:
            await clear_exec_sessions_for_tests()

    asyncio.run(_run())


def test_heartbeat_wake_drops_session_without_pending_events(sqlite_db):
    _create_session("session-no-pending-wake")

    class FakeScheduler:
        def __init__(self) -> None:
            self.jobs = []

        def has_inflight_work(self, session_id: str) -> bool:
            return False

        async def enqueue(self, job) -> None:
            self.jobs.append(job)

    async def _run():
        manager = HeartbeatWakeManager(scheduler=FakeScheduler())
        manager._queue_pending("session-no-pending-wake", "exec-event", "card-1")
        await manager._run_batch()
        assert manager._scheduler.jobs == []
        await manager.stop()

    asyncio.run(_run())


def test_heartbeat_wake_enqueues_job_with_source_and_active_card(sqlite_db):
    _create_session(
        "session-heartbeat-enqueue",
        source=_source(chat_id="chat-heartbeat", chat_type="group", user_id_alt="on_heartbeat"),
    )
    append_agent_session_pending_event(
        "session-heartbeat-enqueue",
        {"event_id": "event-heartbeat", "job_id": "job-heartbeat", "created_at": 1, "text": "done"},
    )

    class FakeScheduler:
        def __init__(self) -> None:
            self.jobs = []

        def has_inflight_work(self, session_id: str) -> bool:
            return False

        async def enqueue(self, job) -> None:
            self.jobs.append(job)

    async def _run():
        scheduler = FakeScheduler()
        manager = HeartbeatWakeManager(scheduler=scheduler)
        manager._queue_pending("session-heartbeat-enqueue", "exec-event", "card-heartbeat")
        await manager._run_batch()
        await manager.stop()
        return scheduler.jobs

    jobs = asyncio.run(_run())
    assert len(jobs) == 1
    job = jobs[0]
    assert job.session_id == "session-heartbeat-enqueue"
    assert job.card_id == "card-heartbeat"
    assert job.session_key == "agent:main:feishu:group:chat-heartbeat:on_heartbeat"
    assert job.source["chat_id"] == "chat-heartbeat"


def test_heartbeat_noop_restores_waiting_status(sqlite_db):
    _create_session(
        "session-heartbeat-noop",
        status=AgentSessionStatus.RUNNING,
    )

    async def _run():
        job = SimpleNamespace(
            job_id="heartbeat-job",
            payload={
                "session_id": "session-heartbeat-noop",
                "card_id": "card-heartbeat-noop",
                "job_id": "heartbeat-job",
                "job_kind": "heartbeat",
                "raw_data": {"heartbeat_reason": "exec-event"},
                "user_text": "",
                "user_content_blocks": [],
            },
        )
        await handle_unified_turn_job(job)

    asyncio.run(_run())

    session = load_agent_session("session-heartbeat-noop")
    assert session is not None
    assert session.status == AgentSessionStatus.WAITING_USER_INPUT
    assert int(session.state_data[RUNTIME_KEY]["session_activity_at"]) > 0


def test_agent_session_control_operations(sqlite_db):
    _create_session(
        "session-control",
        state_data=_state([{"role": "user", "content": "keep me briefly"}]),
    )

    cleared = clear_agent_session_memory("session-control")
    assert cleared is not None
    assert cleared.status == AgentSessionStatus.WAITING_USER_INPUT
    assert cleared.state_data[CONTEXT_KEY]["messages"] == []

    update_agent_session(
        "session-control",
        state_data_patch={CONTEXT_KEY: {"messages": [{"role": "user", "content": "reset me"}]}},
    )
    reset = reset_agent_session_context("session-control")
    assert reset is not None
    assert reset.status == AgentSessionStatus.WAITING_USER_INPUT
    assert reset.state_data[CONTEXT_KEY]["messages"] == []

    cancelled = cancel_agent_session("session-control")
    assert cancelled is not None
    assert cancelled.status == AgentSessionStatus.CANCELLED


def test_agent_session_validation_and_bad_storage_fail_loud(sqlite_db):
    with pytest.raises(RuntimeError, match="non-control runtime fields"):
        _create_session(
            "session-bad-runtime",
            state_data={RUNTIME_KEY: {"not_allowed": True}, CONTEXT_KEY: {"messages": []}},
        )

    _create_session("session-bad-event")
    with pytest.raises(RuntimeError, match="invalid pending event: event_id required"):
        append_agent_session_pending_event(
            "session-bad-event",
            {"job_id": "job-1", "created_at": 1, "text": "missing event id"},
        )

    session_message_path = session_messages_path("session-bad-event")
    session_message_path.write_text("{not-json}\n", encoding="utf-8")
    with pytest.raises(RuntimeError, match="invalid session message JSONL"):
        load_session_messages("session-bad-event")


def test_public_agent_client_uses_sqlite_backend(sqlite_db):
    shared_db_client.init_schema()
    created = asyncio.run(
        shared_db_client.create_agent_session(
            session_id="public-session",
            source=_source(chat_id="public-chat", user_id="public-owner", user_id_alt=""),
            status=AgentSessionStatus.WAITING_USER_INPUT,
            state_data=_state(),
        )
    )
    assert created.session_id == "public-session"

    loaded = asyncio.run(shared_db_client.load_agent_session("public-session"))
    assert loaded is not None
    assert loaded.source["user_id"] == "public-owner"
    postgres_shared_state_client = ".".join(["shared", "db", "postgresql", "shared_state", "client"])
    assert postgres_shared_state_client not in sys.modules
