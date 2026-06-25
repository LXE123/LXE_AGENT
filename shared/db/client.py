"""Public shared-state database interface for response route operations."""

from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor
from functools import partial
from typing import Any

from shared.db.sqlite import agent_state_client as _agent_state
from shared.db.sqlite import response_route_state as _response_route_state

_EXECUTOR = ThreadPoolExecutor(max_workers=4, thread_name_prefix="shared_state_db")


async def _run_db_call(func, *args, **kwargs):
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(_EXECUTOR, partial(func, *args, **kwargs))


async def create_response_route_context(ctx) -> None:
    await _run_db_call(_response_route_state.create_context, ctx)


async def load_response_route_context(response_route_id: str):
    return await _run_db_call(_response_route_state.load_context, response_route_id)


async def load_response_route_session(response_route_id: str):
    context = await load_response_route_context(response_route_id)
    if not context:
        return {}
    return dict(context.extra_data or {})


async def save_response_route_patch(response_route_id: str, patch):
    await _run_db_call(_response_route_state.save_session_patch, response_route_id, patch)


async def save_response_route_delivery_handle(
    response_route_id: str,
    *,
    platform: str | None = None,
    platform_message_id: str | None = None,
):
    return await _run_db_call(
        _response_route_state.save_delivery_handle,
        response_route_id,
        platform=platform,
        platform_message_id=platform_message_id,
    )


async def touch_response_route(response_route_id: str):
    return await _run_db_call(_response_route_state.touch, response_route_id)


async def load_agent_session(session_id: str):
    return await _run_db_call(_agent_state.load_agent_session_state, session_id)


async def create_agent_session(
    *,
    source: dict[str, Any] | None = None,
    state_data: dict | None = None,
    session_id: str = "",
    model: str | None = None,
    model_config: dict[str, Any] | None = None,
    title: str = "",
):
    return await _run_db_call(
        _agent_state.create_agent_session_state,
        source=source,
        state_data=state_data,
        session_id=session_id,
        model=model,
        model_config=model_config,
        title=title,
    )


async def update_agent_session(
    session_id: str,
    *,
    source: dict[str, Any] | None = None,
    state_data_patch: dict | None = None,
    metrics_delta: dict[str, Any] | None = None,
    model: str | None = None,
    model_config: dict[str, Any] | None = None,
    title: str | None = None,
    title_candidate: str | None = None,
):
    return await _run_db_call(
        _agent_state.update_agent_session_state,
        session_id,
        source=source,
        state_data_patch=state_data_patch,
        metrics_delta=metrics_delta,
        model=model,
        model_config=model_config,
        title=title,
        title_candidate=title_candidate,
    )


async def append_agent_session_message(
    session_id: str,
    message: dict[str, Any] | None,
):
    return await _run_db_call(
        _agent_state.append_agent_session_message_state,
        session_id,
        message,
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


# Shared response route lifecycle used by the agent gateway.
__all__ = [
    "append_agent_session_message",
    "append_agent_session_pending_event",
    "cancel_agent_session",
    "clear_agent_session_memory",
    "create_agent_session",
    "create_response_route_context",
    "discard_agent_session_pending_event",
    "dispose",
    "has_agent_session_pending_events",
    "init_schema",
    "load_agent_session",
    "load_response_route_context",
    "load_response_route_session",
    "pop_agent_session_pending_events",
    "reset_agent_session_context",
    "save_response_route_patch",
    "save_response_route_delivery_handle",
    "touch_response_route",
    "update_agent_session",
]
