from __future__ import annotations

import os
from collections.abc import Awaitable, Callable
from uuid import uuid4

from shared.agent_io import EmitRequest, HeartbeatWakeRequest


EmitHandler = Callable[[EmitRequest], Awaitable[None]]
HeartbeatWakeHandler = Callable[[HeartbeatWakeRequest], Awaitable[None]]

_emit_handler: EmitHandler | None = None
_heartbeat_wake_handler: HeartbeatWakeHandler | None = None


def configure_emit_handler(handler: EmitHandler | None) -> None:
    global _emit_handler
    _emit_handler = handler


def configure_heartbeat_wake_handler(handler: HeartbeatWakeHandler | None) -> None:
    global _heartbeat_wake_handler
    _heartbeat_wake_handler = handler


def reset_emit_handlers() -> None:
    configure_emit_handler(None)
    configure_heartbeat_wake_handler(None)


async def send_emit_request(request: EmitRequest) -> None:
    if _emit_handler is None:
        raise RuntimeError("runtime emit handler not configured")
    await _emit_handler(request)


async def request_heartbeat_wake(*, session_id: str, reason: str = "exec-event", response_route_id: str = "") -> None:
    if _heartbeat_wake_handler is None:
        raise RuntimeError("heartbeat wake handler not configured")
    request = HeartbeatWakeRequest(
        session_id=str(session_id or "").strip(),
        reason=str(reason or "exec-event").strip() or "exec-event",
        response_route_id=str(response_route_id or "").strip(),
    )
    if not request.session_id:
        raise RuntimeError("session_id is required")
    await _heartbeat_wake_handler(request)


async def emit(
    *,
    session_id: str,
    response_route_id: str = "",
    content: str = "",
    thinking: str = "",
    redacted_thinking_count: int = 0,
    thinking_elapsed_ms: int = 0,
    files: list[str] | None = None,
    emit_kind: str,
    emit_id: str = "",
    stream_type: str = "",
    state: str = "",
    seq: int = 0,
) -> None:
    normalized_session_id = str(session_id or "").strip()
    normalized_content = str(content or "").strip()
    normalized_thinking = str(thinking or "").strip()
    normalized_redacted_thinking_count = max(0, int(redacted_thinking_count or 0))
    normalized_thinking_elapsed_ms = max(0, int(thinking_elapsed_ms or 0))
    normalized_files = [
        os.path.abspath(str(path or "").strip())
        for path in list(files or [])
        if str(path or "").strip()
    ]
    normalized_emit_kind = str(emit_kind or "").strip()
    if not normalized_session_id:
        raise RuntimeError("session_id is required")
    if normalized_emit_kind not in {"final", "tool", "progress", "stream"}:
        raise RuntimeError(f"unsupported emit_kind: {normalized_emit_kind}")
    normalized_stream_type = str(stream_type or "").strip()
    normalized_state = str(state or "").strip()
    normalized_seq = int(seq or 0)
    if normalized_emit_kind == "stream":
        if normalized_stream_type != "final_answer":
            raise RuntimeError(f"unsupported stream_type: {normalized_stream_type or '<empty>'}")
        if normalized_state not in {"delta", "final", "error"}:
            raise RuntimeError(f"unsupported stream state: {normalized_state or '<empty>'}")
        if normalized_seq <= 0:
            raise RuntimeError(f"invalid stream seq: {normalized_seq}")
    if (
        not normalized_content
        and not normalized_files
        and not normalized_thinking
        and normalized_redacted_thinking_count <= 0
    ):
        return
    await send_emit_request(
        EmitRequest(
            session_id=normalized_session_id,
            response_route_id=str(response_route_id or "").strip(),
            content=normalized_content,
            thinking=normalized_thinking,
            redacted_thinking_count=normalized_redacted_thinking_count,
            thinking_elapsed_ms=normalized_thinking_elapsed_ms,
            files=normalized_files,
            emit_kind=normalized_emit_kind,
            emit_id=str(emit_id or "").strip() or uuid4().hex,
            stream_type=normalized_stream_type,
            state=normalized_state,
            seq=normalized_seq,
        )
    )


async def emit_final(
    *,
    session_id: str,
    response_route_id: str = "",
    content: str,
    files: list[str] | None = None,
    emit_id: str = "",
) -> None:
    await emit(
        session_id=session_id,
        response_route_id=response_route_id,
        content=content,
        files=files,
        emit_kind="final",
        emit_id=emit_id,
    )


async def emit_tool(
    *,
    session_id: str,
    response_route_id: str = "",
    files: list[str],
    emit_id: str = "",
) -> None:
    if not list(files or []):
        return
    await emit(
        session_id=session_id,
        response_route_id=response_route_id,
        files=files,
        emit_kind="tool",
        emit_id=emit_id,
    )


async def emit_stream(
    *,
    session_id: str,
    response_route_id: str,
    stream_type: str,
    state: str,
    seq: int,
    content: str,
    thinking: str = "",
    redacted_thinking_count: int = 0,
    thinking_elapsed_ms: int = 0,
    emit_id: str = "",
) -> None:
    await emit(
        session_id=session_id,
        response_route_id=response_route_id,
        content=content,
        thinking=thinking,
        redacted_thinking_count=redacted_thinking_count,
        thinking_elapsed_ms=thinking_elapsed_ms,
        emit_kind="stream",
        emit_id=emit_id,
        stream_type=stream_type,
        state=state,
        seq=seq,
    )


__all__ = [
    "configure_emit_handler",
    "configure_heartbeat_wake_handler",
    "emit",
    "emit_final",
    "emit_stream",
    "emit_tool",
    "request_heartbeat_wake",
    "reset_emit_handlers",
    "send_emit_request",
]
