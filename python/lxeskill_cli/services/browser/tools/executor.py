from __future__ import annotations

import time
from typing import Any

from services.browser.models.protocol import emit_progress
from services.browser.tools.dispatcher import dispatch_ziniao_browser
from services.browser.tools.models import ExecuteToolResult
from services.browser.tools.schema import build_browser_tool_call
from shared.process_lock import InterProcessLockTimeout


def execute_browser_tool(runtime: Any, *, tool_name: str, arguments: dict[str, Any] | None = None) -> ExecuteToolResult:
    started_at = time.perf_counter()
    tool_call = build_browser_tool_call(name=tool_name, arguments=arguments)
    action = tool_call.arguments["action"]
    emit_progress(f"正在执行紫鸟浏览器动作: {action}")
    try:
        result = dispatch_ziniao_browser(tool_call.arguments)
    except Exception as exc:
        return ExecuteToolResult(
            tool_name=tool_call.name,
            success=False,
            failure_reason=str(exc).strip(),
            error_code="store_busy" if isinstance(exc, InterProcessLockTimeout) else "browser_action_failed",
            payload={"action": action, "user_goal": tool_call.arguments.get("store_id") or action},
            latency_ms=int((time.perf_counter() - started_at) * 1000),
        )
    return ExecuteToolResult(
        tool_name=tool_call.name,
        success=True,
        summary=result["summary"],
        verification=result["verification"],
        payload=result["payload"],
        latency_ms=int((time.perf_counter() - started_at) * 1000),
    )


__all__ = ["execute_browser_tool"]
