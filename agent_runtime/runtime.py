"""Unified agent runtime entry point."""
from __future__ import annotations

from typing import Any, Awaitable, Callable

from shared.permission_policy import allowed_skill_types_for_bot, resolve_bot_id

from .loop import run_agent_turn
from .skill_index import load_skill_index
from .skill_manifest import SkillQueueItem
from .tool_registry import ensure_all_tools_registered, get_registry
from .types import TurnOutcome


ProgressCallback = Callable[[str], Awaitable[None]]
FinalTextCallback = Callable[[str], Awaitable[None]]
StreamCancelCallback = Callable[[], Awaitable[None]]
CancellationCallback = Callable[[], Awaitable[bool]]


def load_available_skills_for_session(session: Any) -> list[SkillQueueItem]:
    skill_index = load_skill_index()
    bot_id = resolve_bot_id(session)
    allowed_skill_types = allowed_skill_types_for_bot(bot_id)
    return skill_index.queue(allowed_types=allowed_skill_types)


async def run_turn(
    *,
    session: Any,
    user_text: str,
    user_content_blocks: list[dict[str, Any]] | None = None,
    run_id: str = "",
    response_route_id: str = "",
    on_progress: ProgressCallback | None = None,
    on_final_text_delta: FinalTextCallback | None = None,
    on_stream_cancel: StreamCancelCallback | None = None,
    cancellation_check: CancellationCallback | None = None,
    cancel_event: Any = None,
    thread_cancel_event: Any = None,
    provider_cancel_registrar: Callable[[Callable[[], None] | None], None] | None = None,
    tool_run_registrar: Callable[[str, str, Callable[[], None] | None], None] | None = None,
    tool_run_finisher: Callable[[str], None] | None = None,
) -> TurnOutcome:
    tool_registry = ensure_all_tools_registered(get_registry())
    state_data = dict(getattr(session, "state_data", {}) or {})
    available_skills = load_available_skills_for_session(session)

    return await run_agent_turn(
        session=session,
        state_data=state_data,
        user_text=user_text,
        user_content_blocks=list(user_content_blocks or []),
        run_id=run_id,
        response_route_id=response_route_id,
        available_skills=available_skills,
        on_progress=on_progress,
        on_final_text_delta=on_final_text_delta,
        on_stream_cancel=on_stream_cancel,
        cancellation_check=cancellation_check,
        cancel_event=cancel_event,
        thread_cancel_event=thread_cancel_event,
        provider_cancel_registrar=provider_cancel_registrar,
        tool_run_registrar=tool_run_registrar,
        tool_run_finisher=tool_run_finisher,
    )


__all__ = ["load_available_skills_for_session", "run_turn"]
