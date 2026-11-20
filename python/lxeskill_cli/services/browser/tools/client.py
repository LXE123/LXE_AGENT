from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from typing import Any

from services.browser.tools import executor as browser_executor
from services.browser.tools.models import ExecuteToolResult, ToolExecutionResult


def _runtime_from_session(session: Any) -> Any:
    if isinstance(session, dict):
        return SimpleNamespace(session_id=str(session.get("session_id") or "").strip())
    return session


def _text_content(result: ExecuteToolResult) -> list[dict[str, Any]]:
    output_parts: list[str] = []
    summary = str(result.summary or "").strip()
    if summary:
        output_parts.append(summary)

    payload = dict(result.payload or {})
    if result.tool_name == "ziniao_browser" and str(payload.get("action") or "").strip() == "get_status":
        status_data = dict(payload.get("data") or {})
        if status_data:
            output_parts.append(f"Status JSON: {json.dumps(status_data, ensure_ascii=False, sort_keys=True)}")

    return [{"type": "text", "text": "\n".join(output_parts) if output_parts else "OK"}]


def _to_tool_execution_result(result: ExecuteToolResult) -> ToolExecutionResult:
    if not result.success:
        return ToolExecutionResult(
            tool_name=result.tool_name,
            success=False,
            error_code=str(result.error_code or "browser_tool_failed").strip() or "browser_tool_failed",
            error_message=str(result.failure_reason or f"{result.tool_name} 执行失败").strip(),
        )

    return ToolExecutionResult(
        tool_name=result.tool_name,
        success=True,
        content=_text_content(result),
    )


async def execute_browser_tool(
    tool_name: str,
    arguments: dict[str, Any] | None,
    session: Any,
) -> ToolExecutionResult:
    runtime = _runtime_from_session(session)
    raw_result = await asyncio.to_thread(
        browser_executor.execute_browser_tool,
        runtime,
        tool_name=str(tool_name or "").strip(),
        arguments=dict(arguments or {}),
    )
    return _to_tool_execution_result(raw_result)


__all__ = ["execute_browser_tool"]
