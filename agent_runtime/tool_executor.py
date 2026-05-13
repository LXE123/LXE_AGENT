"""Tool executor adapter for the unified agent loop.

Acts as the single tool bridge between the agent loop and tool-specific executors.
"""
from __future__ import annotations

import base64
import contextvars
import json
import mimetypes
from pathlib import Path
from typing import Any, Awaitable, Callable

from shared.agent_state import ensure_agent_state, merge_agent_state
from shared.logging import logger
from shared.media.image_processing import compress_image_bytes

from .facts import ToolExecutionFact
from .types import (
    ToolExecutionError,
    ToolResult,
    image_content_block,
    text_content_block,
    text_tool_result,
)


class ToolExecutionContext:
    """Mutable context passed to tool handlers during a turn."""

    def __init__(
        self,
        *,
        session: Any = None,
        state_data: dict[str, Any] | None = None,
        on_progress: Callable[[str], Awaitable[None]] | None = None,
        cancellation_check: Callable[[], Awaitable[bool]] | None = None,
    ) -> None:
        self.session = session
        self.state_data: dict[str, Any] = dict(state_data or {})
        self.on_progress = on_progress
        self.cancellation_check = cancellation_check

    def update_state(self, patch: dict[str, Any] | None) -> None:
        if patch:
            self.state_data.update(patch)


_current_context: contextvars.ContextVar[ToolExecutionContext | None] = contextvars.ContextVar(
    "tool_exec_context", default=None
)

ProgressCallback = Callable[[str], Awaitable[None]]

def set_tool_context(ctx: ToolExecutionContext) -> None:
    _current_context.set(ctx)


def get_tool_context() -> ToolExecutionContext:
    ctx = _current_context.get()
    if ctx is None:
        raise RuntimeError("Tool execution context not set. Call set_tool_context() before executing tools.")
    return ctx


def clear_tool_context() -> None:
    _current_context.set(None)


def _merge_state(base: dict[str, Any] | None, patch: dict[str, Any] | None) -> dict[str, Any]:
    return merge_agent_state(base, patch)


def _sync_session_state(session: Any, state_data: dict[str, Any] | None) -> None:
    try:
        setattr(session, "state_data", ensure_agent_state(state_data))
    except Exception:
        pass


CancellationCheck = Callable[[], Awaitable[bool]]


async def _ensure_browser_ready(
    *,
    session: Any,
    state_data: dict[str, Any],
    tool_name: str,
    on_progress: ProgressCallback | None,
    cancellation_check: CancellationCheck | None = None,
) -> dict[str, Any]:
    current_state = ensure_agent_state(state_data)
    _ = session
    _ = tool_name
    _ = on_progress
    _ = cancellation_check
    return current_state


async def _execute_browser_tool(
    *,
    session: Any,
    state_data: dict[str, Any],
    tool_call: Any,
    on_progress: ProgressCallback | None,
    cancellation_check: CancellationCheck | None = None,
) -> tuple[dict[str, Any], ToolExecutionFact]:
    from agent_runtime.packs.browser.client import invoke_browser_tool_fact

    current_state = await _ensure_browser_ready(
        session=session,
        state_data=state_data,
        tool_name=str(getattr(tool_call, "name", "") or "").strip(),
        on_progress=on_progress,
        cancellation_check=cancellation_check,
    )
    _sync_session_state(session, current_state)
    fact = await invoke_browser_tool_fact(
        session=session,
        tool_name=str(getattr(tool_call, "name", "") or "").strip(),
        arguments=dict(getattr(tool_call, "arguments", {}) or {}),
        on_progress=on_progress,
        cancellation_check=cancellation_check,
    )
    merged = _merge_state(current_state, fact.state_data_patch)
    _sync_session_state(session, merged)
    return merged, fact


def _tool_result_from_fact(tool_name: str, fact: ToolExecutionFact) -> ToolResult:
    summary = str(fact.summary or "").strip()
    failure = str(fact.failure_reason or "").strip()

    if not fact.success:
        raise ToolExecutionError(failure or f"{tool_name} 执行失败")

    fact_payload = dict(fact.payload or {})
    if (
        str(tool_name or "").strip() == "ziniao_page"
        and str(fact_payload.get("action") or "").strip().lower() == "browser_vision"
    ):
        screenshot_path_text = str(fact.screenshot_path or "").strip()
        if not screenshot_path_text:
            raise ToolExecutionError("截图结果缺少 screenshot_path")
        screenshot_path = Path(screenshot_path_text)
        if not screenshot_path.is_file():
            raise ToolExecutionError(f"截图文件不存在: {screenshot_path}")
        try:
            image_bytes = screenshot_path.read_bytes()
        except Exception as exc:
            raise ToolExecutionError(f"读取截图文件失败: {exc}") from exc
        media_type = str(mimetypes.guess_type(str(screenshot_path))[0] or "").strip() or "image/png"
        compressed_bytes, compressed_media_type = compress_image_bytes(image_bytes)
        if compressed_bytes and compressed_media_type:
            image_bytes = compressed_bytes
            media_type = compressed_media_type
        return ToolResult(
            content=[
                text_content_block(f"MEDIA:{screenshot_path}"),
                image_content_block(
                    media_type=media_type,
                    data=base64.b64encode(image_bytes).decode("ascii"),
                ),
            ],
            details={},
        )

    artifacts: dict[str, Any] = {}
    if fact.after_snapshot:
        artifacts["after_snapshot"] = dict(fact.after_snapshot)
    if fact.verification:
        artifacts["verification"] = dict(fact.verification)
    if fact.clicked_element:
        artifacts["clicked_element"] = dict(fact.clicked_element)
    if fact.control_kind:
        artifacts["control"] = fact.control_kind
        if fact.control_text:
            artifacts["control_text"] = fact.control_text

    output_parts: list[str] = []
    if summary:
        output_parts.append(summary)

    snapshot = dict(fact.after_snapshot or {})
    if snapshot:
        page_info = {
            "url": str(snapshot.get("url") or "").strip(),
            "title": str(snapshot.get("title") or "").strip(),
        }
        output_parts.append(f"Page: {json.dumps(page_info, ensure_ascii=False)}")

    if (
        str(tool_name or "").strip() == "ziniao_browser"
        and str(fact_payload.get("action") or "").strip() == "get_status"
    ):
        status_data = dict(fact_payload.get("data") or {})
        if status_data:
            output_parts.append(
                "Status JSON: "
                + json.dumps(status_data, ensure_ascii=False, sort_keys=True)
            )

    details = {}
    if artifacts:
        details["artifacts"] = artifacts

    return text_tool_result(
        "\n".join(output_parts) if output_parts else "OK",
        details=details,
    )


def make_browser_tool_handler(tool_name: str) -> Callable[..., Awaitable[ToolResult]]:
    """Create an async handler for a browser tool."""

    async def _handler(**kwargs: Any) -> ToolResult:
        ctx = get_tool_context()
        logger.info(f"[ToolCall] {tool_name} args={json.dumps(kwargs, ensure_ascii=False)}")

        from agent_runtime.packs.browser.tools import build_browser_tool_call

        try:
            tool_call = build_browser_tool_call(
                name=tool_name,
                arguments=kwargs,
                reason="unified agent loop",
            )
        except ValueError as exc:
            raise ToolExecutionError(f"Invalid tool call: {exc}") from exc

        try:
            updated_state, fact = await _execute_browser_tool(
                session=ctx.session,
                state_data=ctx.state_data,
                tool_call=tool_call,
                on_progress=ctx.on_progress,
                cancellation_check=ctx.cancellation_check,
            )
            ctx.update_state(updated_state)
            logger.info(f"[ToolResult] {tool_name} success={fact.success}")
            if fact.summary:
                logger.info(f"[ToolResult] summary={fact.summary}")
            if fact.failure_reason:
                logger.error(f"[ToolResult] failure={fact.failure_reason}")
        except Exception as exc:
            logger.error(f"[ToolExecutor] {tool_name} failed: {exc}", exc_info=True)
            raise

        return _tool_result_from_fact(tool_name, fact)

    return _handler


__all__ = [
    "ToolExecutionContext",
    "clear_tool_context",
    "get_tool_context",
    "make_browser_tool_handler",
    "set_tool_context",
]
