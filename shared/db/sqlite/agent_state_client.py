from __future__ import annotations

from typing import Any

from shared.logging import logger

from . import bootstrap
from .agent_contexts import (
    load_agent_context,
    load_agent_context_by_user,
    upsert_agent_context,
    update_agent_context,
)
from .agent_sessions import (
    append_agent_session_pending_event,
    cancel_agent_session,
    clear_agent_session_memory,
    create_agent_session,
    discard_agent_session_pending_event,
    has_agent_session_pending_events,
    load_active_agent_session,
    load_active_agent_session_by_owner,
    load_latest_agent_session_for_conversation,
    load_agent_session,
    pop_agent_session_pending_events,
    request_agent_turn_stop,
    reset_stuck_running_sessions,
    reset_agent_session_context,
    update_agent_session,
)


def init_schema() -> None:
    bootstrap.init_schema()
    reset_count = reset_stuck_running_sessions()
    if reset_count > 0:
        logger.info("[SQLite] startup cleanup: %d running agent sessions reset to failed", reset_count)


def dispose() -> None:
    bootstrap.dispose()


def load_agent_session_state(session_id: str):
    return load_agent_session(session_id)


def load_agent_context_state(context_id: str):
    return load_agent_context(context_id)


def load_agent_context_state_by_user(
    owner_user_id: str,
    platform: str | None = None,
    connector_key: str | None = None,
):
    return load_agent_context_by_user(
        owner_user_id,
        platform=platform,
        connector_key=connector_key,
    )


def upsert_agent_context_state(
    *,
    owner_user_id: str,
    platform: str,
    connector_key: str,
    context_data: dict[str, Any] | None = None,
):
    return upsert_agent_context(
        owner_user_id=owner_user_id,
        platform=platform,
        connector_key=connector_key,
        context_data=context_data,
    )


def update_agent_context_state(
    context_id: str,
    *,
    context_patch: dict[str, Any] | None = None,
):
    return update_agent_context(context_id, context_patch=context_patch)


def load_active_agent_session_state(
    conversation_id: str,
    owner_user_id: str,
    platform: str | None = None,
    connector_key: str | None = None,
):
    return load_active_agent_session(
        conversation_id,
        owner_user_id,
        platform=platform,
        connector_key=connector_key,
    )


def load_active_agent_session_state_by_owner(
    owner_user_id: str,
    platform: str | None = None,
    connector_key: str | None = None,
):
    return load_active_agent_session_by_owner(
        owner_user_id,
        platform=platform,
        connector_key=connector_key,
    )


def load_active_agent_session_state_by_user(
    owner_user_id: str,
    platform: str | None = None,
    connector_key: str | None = None,
):
    return load_active_agent_session_by_owner(
        owner_user_id,
        platform=platform,
        connector_key=connector_key,
    )


def load_latest_agent_session_state_for_conversation(
    conversation_id: str,
    owner_user_id: str,
    platform: str | None = None,
    connector_key: str | None = None,
):
    return load_latest_agent_session_for_conversation(
        conversation_id,
        owner_user_id,
        platform=platform,
        connector_key=connector_key,
    )


def create_agent_session_state(
    *,
    card_id: str,
    owner_user_id: str,
    conversation_id: str,
    conversation_type: str,
    sender_nick: str = "",
    platform: str = "dingtalk",
    connector_key: str = "agent",
    status: str,
    state_data: dict[str, Any] | None = None,
    session_id: str = "",
):
    return create_agent_session(
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


def update_agent_session_state(
    session_id: str,
    *,
    card_id: str | None = None,
    conversation_id: str | None = None,
    conversation_type: str | None = None,
    sender_nick: str | None = None,
    status: str | None = None,
    state_data_patch: dict[str, Any] | None = None,
):
    return update_agent_session(
        session_id,
        card_id=card_id,
        conversation_id=conversation_id,
        conversation_type=conversation_type,
        sender_nick=sender_nick,
        status=status,
        state_data_patch=state_data_patch,
    )


def cancel_agent_session_state(
    session_id: str,
    *,
    cancel_reason: str = "user_requested_stop",
):
    return cancel_agent_session(
        session_id,
        cancel_reason=cancel_reason,
    )


def request_agent_turn_stop_state(
    session_id: str,
    *,
    turn_id: str,
    reason: str = "slash_command_stop",
):
    return request_agent_turn_stop(
        session_id,
        turn_id=turn_id,
        reason=reason,
    )


def clear_agent_session_memory_state(
    session_id: str,
    *,
    reason: str = "slash_command_clear",
):
    return clear_agent_session_memory(
        session_id,
        reason=reason,
    )


def append_agent_session_pending_event_state(
    session_id: str,
    event: dict[str, Any] | None,
):
    return append_agent_session_pending_event(session_id, event)


def discard_agent_session_pending_event_state(session_id: str, job_id: str) -> int:
    return discard_agent_session_pending_event(session_id, job_id)


def has_agent_session_pending_events_state(session_id: str) -> bool:
    return has_agent_session_pending_events(session_id)


def pop_agent_session_pending_events_state(session_id: str):
    return pop_agent_session_pending_events(session_id)


def reset_agent_session_state(
    session_id: str,
    *,
    reset_reason: str = "user_requested_context_reset",
):
    return reset_agent_session_context(
        session_id,
        reset_reason=reset_reason,
    )


__all__ = [
    "append_agent_session_pending_event_state",
    "cancel_agent_session_state",
    "clear_agent_session_memory_state",
    "create_agent_session_state",
    "discard_agent_session_pending_event_state",
    "dispose",
    "has_agent_session_pending_events_state",
    "init_schema",
    "load_active_agent_session_state",
    "load_active_agent_session_state_by_owner",
    "load_active_agent_session_state_by_user",
    "load_latest_agent_session_state_for_conversation",
    "load_agent_context_state",
    "load_agent_context_state_by_user",
    "load_agent_session_state",
    "pop_agent_session_pending_events_state",
    "request_agent_turn_stop_state",
    "reset_agent_session_state",
    "upsert_agent_context_state",
    "update_agent_context_state",
    "update_agent_session_state",
]
