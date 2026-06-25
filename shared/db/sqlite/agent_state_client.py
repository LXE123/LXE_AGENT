from __future__ import annotations

from typing import Any

from . import bootstrap
from .agent_sessions import (
    append_agent_session_message,
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


def init_schema() -> None:
    bootstrap.init_schema()


def dispose() -> None:
    bootstrap.dispose()


def load_agent_session_state(session_id: str):
    return load_agent_session(session_id)


def create_agent_session_state(
    *,
    source: dict[str, Any] | None = None,
    state_data: dict[str, Any] | None = None,
    session_id: str = "",
    model: str | None = None,
    model_config: dict[str, Any] | None = None,
    title: str = "",
):
    return create_agent_session(
        source=source,
        state_data=state_data,
        session_id=session_id,
        model=model,
        model_config=model_config,
        title=title,
    )


def update_agent_session_state(
    session_id: str,
    *,
    source: dict[str, Any] | None = None,
    state_data_patch: dict[str, Any] | None = None,
    metrics_delta: dict[str, Any] | None = None,
    model: str | None = None,
    model_config: dict[str, Any] | None = None,
    title: str | None = None,
    title_candidate: str | None = None,
):
    return update_agent_session(
        session_id,
        source=source,
        state_data_patch=state_data_patch,
        metrics_delta=metrics_delta,
        model=model,
        model_config=model_config,
        title=title,
        title_candidate=title_candidate,
    )


def append_agent_session_message_state(
    session_id: str,
    message: dict[str, Any] | None,
):
    return append_agent_session_message(session_id, message)


def cancel_agent_session_state(
    session_id: str,
    *,
    cancel_reason: str = "user_requested_stop",
):
    return cancel_agent_session(
        session_id,
        cancel_reason=cancel_reason,
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
    "append_agent_session_message_state",
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
    "reset_agent_session_state",
    "update_agent_session_state",
]
