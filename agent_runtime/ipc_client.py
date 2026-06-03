from __future__ import annotations

import os
from uuid import uuid4

from shared.agent_ipc import EmitRequest, HeartbeatWakeRequest
from shared.infra.net import HttpSessionPurpose, get_aiohttp_session
from shared.logging import logger

_GATEWAY_IPC_URL = ""


def configure_gateway_ipc(url: str) -> None:
    global _GATEWAY_IPC_URL
    _GATEWAY_IPC_URL = str(url or "").rstrip("/")


async def send_emit_request(request: EmitRequest) -> None:
    if not _GATEWAY_IPC_URL:
        raise RuntimeError("gateway IPC url not configured")
    session = get_aiohttp_session(HttpSessionPurpose.EXTERNAL)
    async with session.post(f"{_GATEWAY_IPC_URL}/agent/emit", json=request.to_dict(), timeout=None) as response:
        payload = await response.json(content_type=None)
        if response.status != 200 or not bool(payload.get("ok")):
            raise RuntimeError(str(payload.get("error") or f"gateway emit failed: status={response.status}"))


async def request_heartbeat_wake(*, session_id: str, reason: str = "exec-event") -> None:
    if not _GATEWAY_IPC_URL:
        raise RuntimeError("gateway IPC url not configured")
    request = HeartbeatWakeRequest(
        session_id=str(session_id or "").strip(),
        reason=str(reason or "exec-event").strip() or "exec-event",
    )
    if not request.session_id:
        raise RuntimeError("session_id is required")
    logger.info(
        "[ExecNotify] wake ipc send: owner_session_id=%s heartbeat_reason=%s gateway_url=%s",
        request.session_id,
        request.reason,
        _GATEWAY_IPC_URL,
    )
    session = get_aiohttp_session(HttpSessionPurpose.EXTERNAL)
    async with session.post(
        f"{_GATEWAY_IPC_URL}/agent/heartbeat-wake",
        json=request.to_dict(),
        timeout=None,
    ) as response:
        payload = await response.json(content_type=None)
        payload_preview = str(payload.get("error") or payload)[:200]
        logger.info(
            "[ExecNotify] wake ipc response: owner_session_id=%s heartbeat_reason=%s status_code=%s ok=%s payload=%s",
            request.session_id,
            request.reason,
            response.status,
            bool(payload.get("ok")),
            payload_preview,
        )
        if response.status != 200 or not bool(payload.get("ok")):
            raise RuntimeError(str(payload.get("error") or f"gateway heartbeat wake failed: status={response.status}"))


async def emit(
    *,
    session_id: str,
    card_id: str = "",
    content: str = "",
    files: list[str] | None = None,
    emit_kind: str,
    emit_id: str = "",
    stream_type: str = "",
    state: str = "",
    seq: int = 0,
) -> None:
    normalized_session_id = str(session_id or "").strip()
    normalized_content = str(content or "").strip()
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
    # `seq` is the source event order. Downstream adapters may remap it to platform-specific sequencing.
    normalized_seq = int(seq or 0)
    if normalized_emit_kind == "stream":
        if normalized_stream_type != "final_answer":
            raise RuntimeError(f"unsupported stream_type: {normalized_stream_type or '<empty>'}")
        if normalized_state not in {"delta", "final", "error"}:
            raise RuntimeError(f"unsupported stream state: {normalized_state or '<empty>'}")
        if normalized_seq <= 0:
            raise RuntimeError(f"invalid stream seq: {normalized_seq}")
    if not normalized_content and not normalized_files:
        return
    await send_emit_request(
        EmitRequest(
            session_id=normalized_session_id,
            card_id=str(card_id or "").strip(),
            content=normalized_content,
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
    card_id: str = "",
    content: str,
    files: list[str] | None = None,
    emit_id: str = "",
) -> None:
    await emit(
        session_id=session_id,
        card_id=card_id,
        content=content,
        files=files,
        emit_kind="final",
        emit_id=emit_id,
    )


async def emit_tool(
    *,
    session_id: str,
    card_id: str = "",
    files: list[str],
    emit_id: str = "",
) -> None:
    if not list(files or []):
        return
    await emit(
        session_id=session_id,
        card_id=card_id,
        files=files,
        emit_kind="tool",
        emit_id=emit_id,
    )


async def emit_stream(
    *,
    session_id: str,
    card_id: str = "",
    stream_type: str,
    state: str,
    seq: int,
    content: str,
    emit_id: str = "",
) -> None:
    await emit(
        session_id=session_id,
        card_id=card_id,
        content=content,
        emit_kind="stream",
        emit_id=emit_id,
        stream_type=stream_type,
        state=state,
        seq=seq,
    )
