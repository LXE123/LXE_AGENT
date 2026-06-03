from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

from aiohttp import web

from gateway.channel_registry import ChannelRegistry
from gateway.models import OutboundRequest as GatewayOutboundRequest
from shared.agent_ipc import EmitRequest, HeartbeatWakeRequest
from shared.db.client import load_agent_session
from shared.logging import logger


class GatewayIpcServer:
    def __init__(
        self,
        *,
        registry: ChannelRegistry,
        host: str,
        port: int,
        on_heartbeat_wake: Callable[[HeartbeatWakeRequest], Awaitable[None]] | None = None,
    ) -> None:
        self._registry = registry
        self._host = str(host or "127.0.0.1").strip() or "127.0.0.1"
        self._port = int(port or 0)
        self._on_heartbeat_wake = on_heartbeat_wake
        self._runner: web.AppRunner | None = None
        self._site: web.TCPSite | None = None

    @property
    def base_url(self) -> str:
        return f"http://{self._host}:{self._port}"

    async def start(self) -> None:
        if self._runner is not None:
            return
        app = web.Application()
        app.router.add_post("/agent/emit", self._handle_emit)
        app.router.add_post("/agent/heartbeat-wake", self._handle_heartbeat_wake)
        self._runner = web.AppRunner(app, access_log=None)
        await self._runner.setup()
        self._site = web.TCPSite(self._runner, host=self._host, port=self._port)
        await self._site.start()
        logger.info("🧩 [GatewayIPC] listening on %s", self.base_url)

    async def stop(self) -> None:
        site = self._site
        runner = self._runner
        self._site = None
        self._runner = None
        if site is not None:
            await site.stop()
        if runner is not None:
            await runner.cleanup()

    async def _handle_emit(self, request: web.Request) -> web.Response:
        try:
            payload = await request.json()
        except Exception:
            return web.json_response({"ok": False, "error": "invalid_json"}, status=400)

        emit = EmitRequest.from_dict(dict(payload or {}))
        if not emit.session_id:
            return web.json_response({"ok": False, "error": "session_id required"}, status=400)
        try:
            await self._dispatch(emit)
        except Exception as exc:
            logger.error("[GatewayIPC] emit dispatch failed: %s", exc, exc_info=True)
            return web.json_response({"ok": False, "error": str(exc)}, status=500)
        return web.json_response({"ok": True})

    async def _handle_heartbeat_wake(self, request: web.Request) -> web.Response:
        try:
            payload = await request.json()
        except Exception:
            return web.json_response({"ok": False, "error": "invalid_json"}, status=400)
        wake = HeartbeatWakeRequest.from_dict(dict(payload or {}))
        if not wake.session_id:
            return web.json_response({"ok": False, "error": "session_id required"}, status=400)
        logger.info(
            "[ExecNotify] wake ipc received: owner_session_id=%s heartbeat_reason=%s",
            wake.session_id,
            wake.reason,
        )
        if self._on_heartbeat_wake is None:
            return web.json_response({"ok": False, "error": "heartbeat wake handler unavailable"}, status=503)
        try:
            await self._on_heartbeat_wake(wake)
        except Exception as exc:
            logger.error("[GatewayIPC] heartbeat wake failed: %s", exc, exc_info=True)
            return web.json_response({"ok": False, "error": str(exc)}, status=500)
        return web.json_response({"ok": True})

    async def _dispatch(self, emit: EmitRequest) -> None:
        session = await load_agent_session(emit.session_id)
        if session is None:
            raise RuntimeError(f"agent session not found: {emit.session_id}")
        emit_kind = str(emit.emit_kind or "").strip()
        platform = str(session.platform or "").strip()
        connector_key = str(session.connector_key or "agent").strip() or "agent"
        adapter = self._registry.get(platform, connector_key)
        logger.info(
            "[GatewayIPC] dispatch emit: session_id=%s kind=%s platform=%s connector=%s content_len=%d files=%d",
            emit.session_id,
            emit_kind,
            platform,
            connector_key,
            len(str(emit.content or "")),
            len(list(emit.files or [])),
        )
        if emit_kind == "progress":
            logger.info(
                "[GatewayIPC] ignore progress emit: session_id=%s emit_id=%s",
                emit.session_id,
                emit.emit_id,
            )
            return
        if emit_kind == "stream":
            await self._send_stream_message(
                adapter,
                emit=emit,
                platform=platform,
                connector_key=connector_key,
                card_id=str(getattr(session, "card_id", "") or "").strip(),
            )
            return
        if emit_kind not in {"tool", "final"}:
            raise RuntimeError(f"unsupported emit_kind: {emit_kind}")

        card_id = str(getattr(session, "card_id", "") or "").strip()
        if emit_kind == "tool":
            await self._send_files(adapter, emit=emit, platform=platform, connector_key=connector_key, card_id=card_id)
            if emit.content:
                await self._send_message(
                    adapter,
                    emit=emit,
                    platform=platform,
                    connector_key=connector_key,
                    card_id=card_id,
                    content=emit.content,
                )
            return

        if emit.content:
            await self._send_message(
                adapter,
                emit=emit,
                platform=platform,
                connector_key=connector_key,
                card_id=card_id,
                content=emit.content,
            )
        await self._send_files(adapter, emit=emit, platform=platform, connector_key=connector_key, card_id=card_id)

    async def _send_stream_message(
        self,
        adapter,
        *,
        emit: EmitRequest,
        platform: str,
        connector_key: str,
        card_id: str,
    ) -> None:
        safe_content = str(emit.content or "").strip()
        if not safe_content:
            return
        logger.info(
            "[GatewayIPC] stream_message: session_id=%s card_id=%s stream_type=%s state=%s seq=%d content_len=%d",
            emit.session_id,
            card_id,
            str(emit.stream_type or "").strip(),
            str(emit.state or "").strip(),
            int(emit.seq or 0),
            len(safe_content),
        )
        request = GatewayOutboundRequest(
            action="stream_message",
            platform=platform,
            connector_key=connector_key,
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
        connector_key: str,
        card_id: str,
        content: str,
    ) -> None:
        safe_content = str(content or "").strip()
        if not safe_content:
            return
        logger.info(
            "[GatewayIPC] send_message: session_id=%s card_id=%s content_len=%d",
            emit.session_id,
            card_id,
            len(safe_content),
        )
        request = GatewayOutboundRequest(
            action="send_message",
            platform=platform,
            connector_key=connector_key,
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
        connector_key: str,
        card_id: str,
    ) -> None:
        for path in list(emit.files or []):
            file_path = str(path or "").strip()
            if not file_path:
                continue
            logger.info(
                "[GatewayIPC] send_file: session_id=%s card_id=%s path=%s",
                emit.session_id,
                card_id,
                file_path,
            )
            request = GatewayOutboundRequest(
                action="send_file",
                platform=platform,
                connector_key=connector_key,
                payload={"path": file_path},
                session_id=emit.session_id,
                card_id=card_id,
                event_id=emit.emit_id,
            )
            await adapter.handle_outbound(request)
