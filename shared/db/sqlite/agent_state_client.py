from __future__ import annotations

from typing import Any

from shared.logging import logger

from . import bootstrap
from .agent_sessions import (
    append_agent_session_pending_event,
    cancel_agent_session,
    clear_agent_session_memory,
    create_agent_session,
    discard_agent_session_pending_event,
    has_agent_session_pending_events,
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


def create_agent_session_state(
    *,
    source: dict[str, Any] | None = None,
    status: str,
    state_data: dict[str, Any] | None = None,
    session_id: str = "",
):
    return create_agent_session(
        source=source,
        status=status,
        state_data=state_data,
        session_id=session_id,
    )


def update_agent_session_state(
    session_id: str,
    *,
    source: dict[str, Any] | None = None,
    status: str | None = None,
    state_data_patch: dict[str, Any] | None = None,
):
    return update_agent_session(
        session_id,
        source=source,
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
    "load_agent_session_state",
    "pop_agent_session_pending_events_state",
    "request_agent_turn_stop_state",
    "reset_agent_session_state",
    "update_agent_session_state",
]
