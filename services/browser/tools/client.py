from __future__ import annotations

import asyncio
import base64
import json
import mimetypes
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from shared.agent_state import ensure_agent_state
from shared.media.image_processing import compress_image_bytes

from services.browser.tools import executor as browser_executor
from services.browser.tools.models import ExecuteToolResult, ToolExecutionResult


def _runtime_from_session(session: Any) -> Any:
    if isinstance(session, dict):
        return SimpleNamespace(
            session_id=str(session.get("session_id") or "").strip(),
            state_data=ensure_agent_state(session.get("state_data") or {}),
        )
    if not hasattr(session, "state_data"):
        setattr(session, "state_data", {})
    return session


def _sync_session_state(session: Any, state_patch: dict[str, Any]) -> None:
    safe_state = ensure_agent_state(state_patch)
    if isinstance(session, dict):
        session["state_data"] = safe_state
        return
    setattr(session, "state_data", safe_state)


def _image_content(path_text: str) -> tuple[list[dict[str, Any]], list[str]]:
    path = Path(str(path_text or "").strip()).expanduser().resolve()
    if not path.is_file():
        raise RuntimeError(f"截图文件不存在: {path}")
    image_bytes = path.read_bytes()
    media_type = str(mimetypes.guess_type(str(path))[0] or "").strip() or "image/png"
    compressed_bytes, compressed_media_type = compress_image_bytes(image_bytes)
    if compressed_bytes and compressed_media_type:
        image_bytes = compressed_bytes
        media_type = compressed_media_type
    return (
        [
            {"type": "text", "text": f"MEDIA:{path}"},
            {
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": media_type,
                    "data": base64.b64encode(image_bytes).decode("ascii"),
                },
            },
        ],
        [str(path)],
    )


def _text_content(result: ExecuteToolResult) -> list[dict[str, Any]]:
    output_parts: list[str] = []
    summary = str(result.summary or "").strip()
    if summary:
        output_parts.append(summary)

    snapshot = dict(result.after_snapshot or {})
    if snapshot:
        page_info = {
            "url": str(snapshot.get("url") or "").strip(),
            "title": str(snapshot.get("title") or "").strip(),
        }
        output_parts.append(f"Page: {json.dumps(page_info, ensure_ascii=False)}")

    payload = dict(result.payload or {})
    if result.tool_name == "ziniao_browser" and str(payload.get("action") or "").strip() == "get_status":
        status_data = dict(payload.get("data") or {})
        if status_data:
            output_parts.append(f"Status JSON: {json.dumps(status_data, ensure_ascii=False, sort_keys=True)}")

    return [{"type": "text", "text": "\n".join(output_parts) if output_parts else "OK"}]


def _to_tool_execution_result(result: ExecuteToolResult) -> ToolExecutionResult:
    state_patch = dict(result.state_data or {})
    if not result.success:
        return ToolExecutionResult(
            tool_name=result.tool_name,
            success=False,
            state_patch=state_patch,
            error_code=str(result.error_code or "browser_tool_failed").strip() or "browser_tool_failed",
            error_message=str(result.failure_reason or f"{result.tool_name} 执行失败").strip(),
        )

    payload = dict(result.payload or {})
    if result.tool_name == "ziniao_page" and str(payload.get("action") or "").strip().lower() == "browser_vision":
        content, files = _image_content(result.screenshot_path)
    else:
        content = _text_content(result)
        files = []
    return ToolExecutionResult(
        tool_name=result.tool_name,
        success=True,
        content=content,
        state_patch=state_patch,
        files=files,
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
    result = _to_tool_execution_result(raw_result)
    _sync_session_state(session, result.state_patch)
    return result


__all__ = ["execute_browser_tool"]
