from __future__ import annotations

import asyncio
from typing import Any, Awaitable, Callable

from agent_runtime.facts import ToolExecutionFact
from shared.agent_state import ensure_agent_state


class _DirectBrowserToolRuntime:
    def __init__(self, session: Any):
        self.session = session
        self.session_id = str(getattr(session, "session_id", "") or "").strip()
        self.state_data = ensure_agent_state(getattr(session, "state_data", {}) or {})


def _fact_from_execute_tool_result(result) -> ToolExecutionFact:
    return ToolExecutionFact(
        tool_name=str(getattr(result, "tool_name", "") or "").strip(),
        success=bool(getattr(result, "success", False)),
        state_data_patch=dict(getattr(result, "state_data", {}) or {}),
        summary=str(getattr(result, "summary", "") or "").strip(),
        verification=dict(getattr(result, "verification", {}) or {}),
        after_snapshot=dict(getattr(result, "after_snapshot", {}) or {}),
        screenshot_path=str(getattr(result, "screenshot_path", "") or "").strip(),
        payload=dict(getattr(result, "payload", {}) or {}),
        failure_reason=str(getattr(result, "failure_reason", "") or "").strip(),
        error_code=str(getattr(result, "error_code", "") or "").strip(),
        clicked_element=dict(getattr(result, "clicked_element", {}) or {}),
        latency_ms=int(getattr(result, "latency_ms", 0) or 0),
        control_kind="",
        control_text="",
        user_goal="",
    )


async def invoke_browser_tool_fact(
    *,
    session,
    tool_name: str,
    arguments: dict[str, Any] | None = None,
    on_progress: Callable[[str], Awaitable[None]] | None = None,
    cancellation_check: Callable[[], Awaitable[bool]] | None = None,
) -> ToolExecutionFact:
    _ = on_progress
    _ = cancellation_check
    from agent_runtime.packs.browser.executor import execute_browser_tool

    runtime = _DirectBrowserToolRuntime(session)
    execute_result = await asyncio.to_thread(
        execute_browser_tool,
        runtime,
        tool_name=str(tool_name or "").strip(),
        arguments=dict(arguments or {}),
    )
    try:
        setattr(session, "state_data", ensure_agent_state(runtime.state_data))
    except Exception:
        pass
    return _fact_from_execute_tool_result(execute_result)


__all__ = [
    "invoke_browser_tool_fact",
]
