from __future__ import annotations

from shared.agent_io import EmitRequest
from shared.db.client import load_agent_session, load_card_context
from shared.logging import logger

from .channel_registry import ChannelRegistry
from .models import OutboundRequest


class GatewayEmitter:
    def __init__(self, *, registry: ChannelRegistry) -> None:
        self._registry = registry

    async def emit(self, emit: EmitRequest) -> None:
        session = await load_agent_session(emit.session_id)
        if session is None:
            raise RuntimeError(f"agent session not found: {emit.session_id}")
        emit_kind = str(emit.emit_kind or "").strip()
        card_id = str(emit.card_id or "").strip()
        card_ctx = await load_card_context(card_id) if card_id else None
        source = dict(getattr(session, "source", {}) or {})
        platform = str(card_ctx.platform or "").strip() if card_ctx is not None else str(source.get("platform") or "").strip()
        adapter = self._registry.get(platform)
        logger.info(
            "[GatewayEmitter] dispatch emit: session_id=%s kind=%s platform=%s card_id=%s content_len=%d files=%d",
            emit.session_id,
            emit_kind,
            platform,
            card_id,
            len(str(emit.content or "")),
            len(list(emit.files or [])),
        )
        if emit_kind == "progress":
            logger.info("[GatewayEmitter] ignore progress emit: session_id=%s emit_id=%s", emit.session_id, emit.emit_id)
            return
        if emit_kind == "stream":
            await self._send_stream_message(adapter, emit=emit, platform=platform, card_id=card_id)
            return
        if emit_kind not in {"tool", "final"}:
            raise RuntimeError(f"unsupported emit_kind: {emit_kind}")

        if emit_kind == "tool":
            await self._send_files(adapter, emit=emit, platform=platform, card_id=card_id)
            if emit.content:
                await self._send_message(adapter, emit=emit, platform=platform, card_id=card_id, content=emit.content)
            return

        if emit.content:
            await self._send_message(adapter, emit=emit, platform=platform, card_id=card_id, content=emit.content)
        await self._send_files(adapter, emit=emit, platform=platform, card_id=card_id)

    async def emit_stream(
        self,
        *,
        session_id: str,
        card_id: str,
        stream_type: str,
        state: str,
        seq: int,
        content: str,
        emit_id: str = "",
    ) -> None:
        await self.emit(
            EmitRequest(
                session_id=str(session_id or "").strip(),
                card_id=str(card_id or "").strip(),
                content=str(content or "").strip(),
                emit_kind="stream",
                emit_id=str(emit_id or "").strip(),
                stream_type=str(stream_type or "").strip(),
                state=str(state or "").strip(),
                seq=int(seq or 0),
            )
        )

    async def emit_final(
        self,
        *,
        session_id: str,
        card_id: str = "",
        content: str,
        files: list[str] | None = None,
        emit_id: str = "",
    ) -> None:
        await self.emit(
            EmitRequest(
                session_id=str(session_id or "").strip(),
                card_id=str(card_id or "").strip(),
                content=str(content or "").strip(),
                files=list(files or []),
                emit_kind="final",
                emit_id=str(emit_id or "").strip(),
            )
        )

    async def _send_stream_message(
        self,
        adapter,
        *,
        emit: EmitRequest,
        platform: str,
        card_id: str,
    ) -> None:
        safe_content = str(emit.content or "").strip()
        if not safe_content:
            return
        logger.info(
            "[GatewayEmitter] stream_message: session_id=%s card_id=%s stream_type=%s state=%s seq=%d content_len=%d",
            emit.session_id,
            card_id,
            str(emit.stream_type or "").strip(),
            str(emit.state or "").strip(),
            int(emit.seq or 0),
            len(safe_content),
        )
        request = OutboundRequest(
            action="stream_message",
            platform=platform,
            payload={
                "stream_type": str(emit.stream_type or "").strip(),
                "state": str(emit.state or "").strip(),
                "seq": int(emit.seq or 0),
                "content": safe_content,
            },
            session_id=emit.session_id,
            card_id=card_id,
            event_id=emit.emit_id,
        )
        await adapter.handle_outbound(request)

    async def _send_message(
        self,
        adapter,
        *,
        emit: EmitRequest,
        platform: str,
        card_id: str,
        content: str,
    ) -> None:
        safe_content = str(content or "").strip()
        if not safe_content:
            return
        logger.info("[GatewayEmitter] send_message: session_id=%s card_id=%s content_len=%d", emit.session_id, card_id, len(safe_content))
        request = OutboundRequest(
            action="send_message",
            platform=platform,
            payload={"markdown": safe_content},
            session_id=emit.session_id,
            card_id=card_id,
            event_id=emit.emit_id,
        )
        await adapter.handle_outbound(request)

    async def _send_files(
        self,
        adapter,
        *,
        emit: EmitRequest,
        platform: str,
        card_id: str,
    ) -> None:
        for path in list(emit.files or []):
            file_path = str(path or "").strip()
            if not file_path:
                continue
            logger.info("[GatewayEmitter] send_file: session_id=%s card_id=%s path=%s", emit.session_id, card_id, file_path)
            request = OutboundRequest(
                action="send_file",
                platform=platform,
                payload={"path": file_path},
                session_id=emit.session_id,
                card_id=card_id,
                event_id=emit.emit_id,
            )
            await adapter.handle_outbound(request)


__all__ = ["GatewayEmitter"]
