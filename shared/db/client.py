"""Public shared-state database interface for card context operations."""

from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor
from functools import partial
from typing import Any

from shared.db.sqlite import agent_state_client as _agent_state
from shared.db.sqlite import card_state as _sqlite_card_state

_EXECUTOR = ThreadPoolExecutor(max_workers=4, thread_name_prefix="shared_state_db")


async def _run_db_call(func, *args, **kwargs):
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(_EXECUTOR, partial(func, *args, **kwargs))


async def create_card_context(ctx) -> None:
    await _run_db_call(_sqlite_card_state.create_context, ctx)


async def load_card_context(out_track_id: str):
    return await _run_db_call(_sqlite_card_state.load_context, out_track_id)


async def load_card_session(out_track_id: str):
    context = await load_card_context(out_track_id)
    if not context:
        return {}
    return dict(context.extra_data or {})


async def save_card_session_patch(out_track_id: str, patch):
    await _run_db_call(_sqlite_card_state.save_session_patch, out_track_id, patch)


async def save_card_delivery_handle(
    out_track_id: str,
    *,
    platform: str | None = None,
    connector_key: str | None = None,
    platform_message_id: str | None = None,
):
    return await _run_db_call(
        _sqlite_card_state.save_delivery_handle,
        out_track_id,
        platform=platform,
        connector_key=connector_key,
        platform_message_id=platform_message_id,
    )


async def touch_card(out_track_id: str):
    return await _run_db_call(_sqlite_card_state.touch, out_track_id)


async def load_agent_session(session_id: str):
    return await _run_db_call(_agent_state.load_agent_session_state, session_id)


async def load_agent_context(context_id: str):
    return await _run_db_call(_agent_state.load_agent_context_state, context_id)


async def load_agent_context_by_user(
    owner_user_id: str,
    platform: str | None = None,
    connector_key: str | None = None,
):
    return await _run_db_call(
        _agent_state.load_agent_context_state_by_user,
        owner_user_id,
        platform=platform,
        connector_key=connector_key,
    )


async def upsert_agent_context(
    *,
    owner_user_id: str,
    platform: str,
    connector_key: str,
    context_data: dict | None = None,
):
    return await _run_db_call(
        _agent_state.upsert_agent_context_state,
        owner_user_id=owner_user_id,
        platform=platform,
        connector_key=connector_key,
        context_data=context_data,
    )


async def update_agent_context(
    context_id: str,
    *,
    context_patch: dict | None = None,
):
    return await _run_db_call(
        _agent_state.update_agent_context_state,
        context_id,
        context_patch=context_patch,
    )


async def load_active_agent_session(
    conversation_id: str,
    owner_user_id: str,
    platform: str | None = None,
    connector_key: str | None = None,
):
    return await _run_db_call(
        _agent_state.load_active_agent_session_state,
        conversation_id,
        owner_user_id,
        platform=platform,
        connector_key=connector_key,
    )


async def load_active_agent_session_by_owner(
    owner_user_id: str,
    platform: str | None = None,
    connector_key: str | None = None,
):
    return await _run_db_call(
        _agent_state.load_active_agent_session_state_by_owner,
        owner_user_id,
        platform=platform,
        connector_key=connector_key,
    )


async def load_active_agent_session_by_user(
    owner_user_id: str,
    platform: str | None = None,
    connector_key: str | None = None,
):
    return await _run_db_call(
        _agent_state.load_active_agent_session_state_by_user,
        owner_user_id,
        platform=platform,
        connector_key=connector_key,
    )


async def load_latest_agent_session_for_conversation(
    conversation_id: str,
    owner_user_id: str,
    platform: str | None = None,
    connector_key: str | None = None,
):
    return await _run_db_call(
        _agent_state.load_latest_agent_session_state_for_conversation,
        conversation_id,
        owner_user_id,
        platform=platform,
        connector_key=connector_key,
    )


async def create_agent_session(
    *,
    card_id: str,
    owner_user_id: str,
    conversation_id: str,
    conversation_type: str,
    sender_nick: str = "",
    platform: str = "feishu",
    connector_key: str = "agent",
    status: str,
    state_data: dict | None = None,
    session_id: str = "",
):
    return await _run_db_call(
        _agent_state.create_agent_session_state,
        card_id=card_id,
        owner_user_id=owner_user_id,
        conversation_id=conversation_id,
        conversation_type=conversation_type,
        sender_nick=sender_nick,
        platform=platform,
        connector_key=connector_key,
        status=status,
        state_data=state_data,
        session_id=session_id,
    )


async def update_agent_session(
    session_id: str,
    *,
    card_id: str | None = None,
    conversation_id: str | None = None,
    conversation_type: str | None = None,
    sender_nick: str | None = None,
    status: str | None = None,
    state_data_patch: dict | None = None,
):
    return await _run_db_call(
        _agent_state.update_agent_session_state,
        session_id,
        card_id=card_id,
        conversation_id=conversation_id,
        conversation_type=conversation_type,
        sender_nick=sender_nick,
        status=status,
        state_data_patch=state_data_patch,
    )


async def cancel_agent_session(
    session_id: str,
    *,
    cancel_reason: str = "user_requested_stop",
):
    return await _run_db_call(
        _agent_state.cancel_agent_session_state,
        session_id,
        cancel_reason=cancel_reason,
    )


async def request_agent_turn_stop(
    session_id: str,
    *,
    turn_id: str,
    reason: str = "slash_command_stop",
):
    return await _run_db_call(
        _agent_state.request_agent_turn_stop_state,
        session_id,
        turn_id=turn_id,
        reason=reason,
    )


async def clear_agent_session_memory(
    session_id: str,
    *,
    reason: str = "slash_command_clear",
):
    return await _run_db_call(
        _agent_state.clear_agent_session_memory_state,
        session_id,
        reason=reason,
    )


async def append_agent_session_pending_event(session_id: str, event: dict[str, Any] | None):
    return await _run_db_call(
        _agent_state.append_agent_session_pending_event_state,
        session_id,
        event,
    )


async def discard_agent_session_pending_event(session_id: str, job_id: str) -> int:
    return await _run_db_call(
        _agent_state.discard_agent_session_pending_event_state,
        session_id,
        job_id,
    )


async def has_agent_session_pending_events(session_id: str) -> bool:
    return await _run_db_call(
        _agent_state.has_agent_session_pending_events_state,
        session_id,
    )


async def pop_agent_session_pending_events(session_id: str):
    return await _run_db_call(
        _agent_state.pop_agent_session_pending_events_state,
        session_id,
    )


async def reset_agent_session_context(
    session_id: str,
    *,
    reset_reason: str = "user_requested_context_reset",
):
    return await _run_db_call(
        _agent_state.reset_agent_session_state,
        session_id,
        reset_reason=reset_reason,
    )


def init_schema() -> None:
    _agent_state.init_schema()


def dispose() -> None:
    try:
        _agent_state.dispose()
    finally:
        _EXECUTOR.shutdown(wait=False, cancel_futures=True)


# Shared card context lifecycle used by the agent gateway.
__all__ = [
    "append_agent_session_pending_event",
    "cancel_agent_session",
    "clear_agent_session_memory",
    "create_agent_session",
    "create_card_context",
    "discard_agent_session_pending_event",
    "dispose",
    "has_agent_session_pending_events",
    "init_schema",
    "load_active_agent_session",
    "load_active_agent_session_by_owner",
    "load_active_agent_session_by_user",
    "load_latest_agent_session_for_conversation",
    "load_agent_context",
    "load_agent_context_by_user",
    "load_agent_session",
    "load_card_context",
    "load_card_session",
    "pop_agent_session_pending_events",
    "request_agent_turn_stop",
    "reset_agent_session_context",
    "save_card_session_patch",
    "save_card_delivery_handle",
    "touch_card",
    "upsert_agent_context",
    "update_agent_context",
    "update_agent_session",
]
