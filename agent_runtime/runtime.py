"""Unified agent runtime entry point."""
from __future__ import annotations

from typing import Any, Awaitable, Callable

from .loop import run_agent_turn
from .skill_index import load_skill_index
from .tool_registry import ensure_all_tools_registered, get_registry
from .types import TurnOutcome


ProgressCallback = Callable[[str], Awaitable[None]]
FinalTextCallback = Callable[[str], Awaitable[None]]
StreamCancelCallback = Callable[[], Awaitable[None]]
CancellationCallback = Callable[[], Awaitable[bool]]


async def run_turn(
    *,
    session: Any,
    user_text: str,
    user_content_blocks: list[dict[str, Any]] | None = None,
    on_progress: ProgressCallback | None = None,
    on_final_text_delta: FinalTextCallback | None = None,
    on_stream_cancel: StreamCancelCallback | None = None,
    cancellation_check: CancellationCallback | None = None,
) -> TurnOutcome:
    tool_registry = ensure_all_tools_registered(get_registry())
    skill_index = load_skill_index()

    state_data = dict(getattr(session, "state_data", {}) or {})
    available_skills = skill_index.queue()

    return await run_agent_turn(
        session=session,
        state_data=state_data,
        user_text=user_text,
        user_content_blocks=list(user_content_blocks or []),
        available_skills=available_skills,
        on_progress=on_progress,
        on_final_text_delta=on_final_text_delta,
        on_stream_cancel=on_stream_cancel,
        cancellation_check=cancellation_check,
    )


__all__ = ["run_turn"]
