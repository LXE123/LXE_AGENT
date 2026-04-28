from __future__ import annotations

import asyncio
import importlib
import threading
import time
import uuid
from dataclasses import dataclass, field
from types import SimpleNamespace
from typing import Any, Literal

from gateway.models import InboundEvent, OutboundRequest
from shared.db.client import load_card_context
from shared.logging import logger
from shared.platform.adapter import InboundSink

from .bot_probe import probe_feishu_bot_identity
from .cardkit_sender import FeishuCardKitError, FeishuCardKitSender
from .card_sender import FeishuCardSender
from .config import (
    FEISHU_APP_ID,
    FEISHU_APP_SECRET,
    FEISHU_BOT_OPEN_ID,
    feishu_runtime_status,
    validate_feishu_runtime_config,
)
from .inbound_media import resolve_inbound_message
from .media_sender import FeishuMediaSender
from .api_client import api_client
from .message_parser import is_bot_mentioned, parse_message_payload_async, strip_bot_mention


_RECOVERABLE_CARDKIT_ERROR_CODE = 200850
_StreamStatus = Literal["streaming", "reopening", "dead", "finalized"]


@dataclass(slots=True)
class _StreamWriterState:
    source_seq: int = 0
    card_seq: int = 0
    status: _StreamStatus = "streaming"
    last_content: str = ""
    last_sent_content: str = ""
    reopen_count: int = 0
    final_requested: bool = False
    final_error: bool = False
    opened: bool = False
    finished: bool = False
    reopen_task: asyncio.Task[None] | None = field(default=None, repr=False)


class FeishuStreamAdapter:
    platform = "feishu"

    def __init__(self, *, connector_key: str = "agent") -> None:
        validate_feishu_runtime_config()
        self.connector_key = str(connector_key or "").strip() or "agent"
        self._inbound_sink: InboundSink | None = None
        self._host_loop: asyncio.AbstractEventLoop | None = None
        self._thread: threading.Thread | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._client: Any = None
        self._card_sender = FeishuCardSender()
        self._cardkit_sender = FeishuCardKitSender()
        self._media_sender = FeishuMediaSender()
        self._stream_state: dict[str, _StreamWriterState] = {}
        self._stream_locks: dict[str, asyncio.Lock] = {}
        self._bot_open_id = str(FEISHU_BOT_OPEN_ID or "").strip()
        self._bot_name = ""
        self._bot_open_id_source = "env" if self._bot_open_id else ""
        self._last_probe_ok = False
        self._last_probe_at = 0.0
        self._ready = threading.Event()
        self._start_error: BaseException | None = None
        self._stopping = False

    def set_inbound_sink(self, sink: InboundSink) -> None:
        self._inbound_sink = sink

    def _connection_health(self) -> tuple[bool, str]:
        thread_alive = bool(self._thread and self._thread.is_alive())
        conn = getattr(self._client, "_conn", None) if self._client is not None else None
        connection_alive = bool(conn is not None and not getattr(conn, "closed", True))
        if not thread_alive:
            return connection_alive, "stopped"
        if connection_alive:
            return connection_alive, "connected"
        return connection_alive, "disconnected"

    def health(self) -> dict[str, Any]:
        thread_alive = bool(self._thread and self._thread.is_alive())
        connection_alive, connection_state = self._connection_health()
        return {
            "running": thread_alive,
            "thread_alive": thread_alive,
            "connection_alive": connection_alive,
            "connection_state": connection_state,
            "thread": self._thread.name if self._thread else "",
            "loop": self._loop.__class__.__name__ if self._loop else "",
            "connector_key": self.connector_key,
            "bot_open_id_configured": bool(self._bot_open_id),
            "bot_open_id_source": self._bot_open_id_source,
            "bot_name": self._bot_name,
            "last_probe_ok": self._last_probe_ok,
        }

    async def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        if self._inbound_sink is None:
            raise RuntimeError("inbound sink not configured for feishu adapter")

        self._clear_runtime_handles(
            expected_thread=self._thread,
            expected_loop=self._loop,
            clear_host_loop=True,
        )
        self._host_loop = asyncio.get_running_loop()
        await self._refresh_bot_identity_if_needed()
        self._ready.clear()
        self._start_error = None
        self._stopping = False
        self._thread = threading.Thread(
            target=self._run_thread,
            name=f"adapter:feishu:{self.connector_key}",
            daemon=True,
        )
        self._thread.start()
        await asyncio.to_thread(self._ready.wait, 15)
        if self._start_error is not None:
            raise RuntimeError(f"feishu adapter failed: {self._start_error}") from self._start_error

    async def stop(self) -> None:
        thread = self._thread
        loop = self._loop
        if thread is None or not thread.is_alive():
            self._clear_runtime_handles(
                expected_thread=thread,
                expected_loop=loop,
                clear_host_loop=True,
            )
            return
        self._stopping = True
        if loop is not None and not loop.is_closed():
            try:
                future = asyncio.run_coroutine_threadsafe(self._shutdown_loop(), loop)
                await asyncio.wait_for(asyncio.wrap_future(future), timeout=5.0)
            except Exception:
                pass
            try:
                loop.call_soon_threadsafe(loop.stop)
            except Exception:
                pass
        await asyncio.to_thread(thread.join, 5)
        if thread.is_alive():
            raise RuntimeError(f"feishu adapter thread did not stop: {thread.name}")
        self._clear_runtime_handles(
            expected_thread=thread,
            expected_loop=loop,
            clear_host_loop=True,
        )

    def emit(self, event: InboundEvent) -> None:
        if self._inbound_sink is None:
            raise RuntimeError("inbound sink not configured for feishu adapter")
        logger.info(
            "[Feishu] inbound accepted: connector=%s chat_type=%s chat_id=%s msg_id=%s user_id=%s text=%s",
            self.connector_key,
            "group" if event.is_group else "p2p",
            str(event.conversation_id or "").strip(),
            str(event.message_id or "").strip(),
            str(event.user_id or "").strip(),
            str(event.user_input or "")[:120],
        )
        self._inbound_sink(event)

    async def handle_outbound(self, request: OutboundRequest) -> None:
        card_ctx = await _load_send_context(request.card_id, session_id=request.session_id)
        logger.info(
            "[Feishu] outbound request: action=%s session_id=%s card_id=%s event_id=%s connector=%s",
            request.action,
            str(request.session_id or "").strip(),
            str(request.card_id or "").strip(),
            str(request.event_id or "").strip(),
            self.connector_key,
        )
        if request.action == "stream_message":
            await self._handle_stream_message(request, card_ctx)
            return
        if request.action == "send_message":
            card_params = dict(request.payload.get("card_params") or {})
            markdown = str(request.payload.get("markdown") or "").strip()
            title = str(request.payload.get("title") or "").strip()
            if card_params:
                await self._card_sender.send_card(card_ctx, request.card_id, card_params)
                return
            if markdown:
                sent = await self._media_sender.send_markdown_card(card_ctx, markdown, title=title)
                if sent:
                    return
            raise RuntimeError("empty feishu send_message payload")
        if request.action == "send_file":
            path = str(request.payload.get("path") or "").strip()
            if not path:
                raise RuntimeError("missing file path")
            sent = await self._media_sender.send_file(card_ctx, path)
            if sent:
                return
            raise RuntimeError(f"feishu file send failed: {path}")
        if request.action == "react":
            logger.info("[Feishu] ignore unsupported react action for connector=%s", self.connector_key)
            return
        raise RuntimeError(f"unsupported outbound action: {request.action}")

    async def _handle_stream_message(self, request: OutboundRequest, card_ctx: Any) -> None:
        session_id = str(request.session_id or "").strip()
        if not session_id:
            raise RuntimeError("missing session_id for feishu stream_message")

        payload = dict(request.payload or {})
        stream_type = str(payload.get("stream_type") or "").strip()
        state = str(payload.get("state") or "").strip()
        source_seq = int(payload.get("seq") or 0)
        content = str(payload.get("content") or "").strip()
        emit_id = str(request.event_id or "").strip()
        if stream_type != "final_answer":
            raise RuntimeError(f"unsupported feishu stream_type: {stream_type or '<empty>'}")
        if state not in {"delta", "final", "error"}:
            raise RuntimeError(f"unsupported feishu stream state: {state or '<empty>'}")
        if source_seq <= 0:
            raise RuntimeError(f"invalid feishu stream seq: {source_seq}")
        if not content:
            return

        async with self._get_stream_lock(session_id):
            writer = self._stream_state.get(session_id)
            if writer is None:
                writer = _StreamWriterState()
                self._stream_state[session_id] = writer
            if writer.finished or writer.status == "finalized":
                logger.info("[Feishu] ignore finished stream frame: session_id=%s seq=%d", session_id, source_seq)
                return
            if source_seq <= writer.source_seq:
                logger.info("[Feishu] ignore stale stream frame: session_id=%s seq=%d", session_id, source_seq)
                return

            writer.source_seq = source_seq
            writer.last_content = content
            if state in {"final", "error"}:
                writer.final_requested = True
                writer.final_error = state == "error"

            if writer.status == "dead":
                if writer.final_requested:
                    writer.status = "finalized"
                    writer.finished = True
                    self._cleanup_stream_state(session_id)
                return

            if writer.status == "reopening":
                return

            if state == "delta":
                if content == writer.last_sent_content:
                    return
                await self._send_delta_locked(
                    session_id=session_id,
                    writer=writer,
                    request=request,
                    card_ctx=card_ctx,
                    emit_id=emit_id,
                )
                return

            await self._finalize_locked(
                session_id=session_id,
                writer=writer,
                request=request,
                card_ctx=card_ctx,
                emit_id=emit_id,
            )
            if writer.finished:
                self._cleanup_stream_state(session_id)

    def _get_stream_lock(self, session_id: str) -> asyncio.Lock:
        lock = self._stream_locks.get(session_id)
        if lock is None:
            lock = asyncio.Lock()
            self._stream_locks[session_id] = lock
        return lock

    def _next_card_sequence(self, writer: _StreamWriterState) -> int:
        writer.card_seq += 1
        return writer.card_seq

    def _reserve_finalize_sequence(self, writer: _StreamWriterState) -> int:
        content_sequence = self._next_card_sequence(writer)
        writer.card_seq += 1
        return content_sequence

    async def _send_delta_locked(
        self,
        *,
        session_id: str,
        writer: _StreamWriterState,
        request: OutboundRequest,
        card_ctx: Any,
        emit_id: str,
    ) -> None:
        sequence = self._next_card_sequence(writer)
        try:
            await self._cardkit_sender.stream_text(
                card_ctx,
                request.card_id,
                content=writer.last_content,
                sequence=sequence,
                emit_id=emit_id,
            )
        except FeishuCardKitError as error:
            await self._handle_cardkit_error_locked(
                session_id=session_id,
                writer=writer,
                request=request,
                card_ctx=card_ctx,
                emit_id=emit_id,
                error=error,
                terminal=False,
            )
            return
        writer.last_sent_content = writer.last_content
        writer.opened = True

    async def _finalize_locked(
        self,
        *,
        session_id: str,
        writer: _StreamWriterState,
        request: OutboundRequest,
        card_ctx: Any,
        emit_id: str,
    ) -> None:
        sequence = self._reserve_finalize_sequence(writer)
        try:
            await self._cardkit_sender.finalize_text(
                card_ctx,
                request.card_id,
                content=writer.last_content,
                sequence=sequence,
                error=writer.final_error,
                emit_id=emit_id,
            )
        except FeishuCardKitError as error:
            await self._handle_cardkit_error_locked(
                session_id=session_id,
                writer=writer,
                request=request,
                card_ctx=card_ctx,
                emit_id=emit_id,
                error=error,
                terminal=True,
            )
            return
        writer.last_sent_content = writer.last_content
        writer.opened = True
        writer.status = "finalized"
        writer.finished = True

    async def _handle_cardkit_error_locked(
        self,
        *,
        session_id: str,
        writer: _StreamWriterState,
        request: OutboundRequest,
        card_ctx: Any,
        emit_id: str,
        error: FeishuCardKitError,
        terminal: bool,
    ) -> None:
        if (
            error.code == _RECOVERABLE_CARDKIT_ERROR_CODE
            and writer.reopen_count == 0
            and error.cardkit_card_id
        ):
            writer.status = "reopening"
            writer.reopen_count += 1
            if writer.reopen_task is None:
                task = asyncio.create_task(
                    self._resume_after_reopen(
                        session_id=session_id,
                        card_id=request.card_id,
                        card_ctx=card_ctx,
                        emit_id=emit_id,
                        cardkit_card_id=error.cardkit_card_id,
                    )
                )
                writer.reopen_task = task
                task.add_done_callback(
                    lambda done_task, *, stream_session_id=session_id: self._handle_reopen_task_done(
                        stream_session_id,
                        done_task,
                    )
                )
            return

        writer.status = "dead"
        logger.warning(
            "[Feishu] mark stream dead: session_id=%s card_id=%s code=%s operation=%s terminal=%s",
            session_id,
            request.card_id,
            error.code,
            error.operation,
            terminal,
        )
        if terminal:
            writer.status = "finalized"
            writer.finished = True

    async def _resume_after_reopen(
        self,
        *,
        session_id: str,
        card_id: str,
        card_ctx: Any,
        emit_id: str,
        cardkit_card_id: str,
    ) -> None:
        reopen_sequence = 0
        async with self._get_stream_lock(session_id):
            writer = self._stream_state.get(session_id)
            if writer is None or writer.status != "reopening":
                return
            reopen_sequence = self._next_card_sequence(writer)
        try:
            await self._cardkit_sender.reopen_streaming_mode(
                cardkit_card_id,
                sequence=reopen_sequence,
                summary="回答生成中...",
            )
        except FeishuCardKitError as error:
            async with self._get_stream_lock(session_id):
                writer = self._stream_state.get(session_id)
                if writer is None:
                    return
                writer.status = "dead"
                if writer.final_requested:
                    writer.status = "finalized"
                    writer.finished = True
                    self._cleanup_stream_state(session_id)
            logger.warning(
                "[Feishu] reopen failed: session_id=%s card_id=%s code=%s operation=%s",
                session_id,
                card_id,
                error.code,
                error.operation,
            )
            return

        async with self._get_stream_lock(session_id):
            writer = self._stream_state.get(session_id)
            if writer is None or writer.status != "reopening":
                return
            try:
                if writer.final_requested:
                    sequence = self._reserve_finalize_sequence(writer)
                    await self._cardkit_sender.finalize_text(
                        card_ctx,
                        card_id,
                        content=writer.last_content,
                        sequence=sequence,
                        error=writer.final_error,
                        emit_id=emit_id,
                    )
                    writer.last_sent_content = writer.last_content
                    writer.opened = True
                    writer.status = "finalized"
                    writer.finished = True
                    self._cleanup_stream_state(session_id)
                    return

                if writer.last_content != writer.last_sent_content:
                    sequence = self._next_card_sequence(writer)
                    await self._cardkit_sender.stream_text(
                        card_ctx,
                        card_id,
                        content=writer.last_content,
                        sequence=sequence,
                        emit_id=emit_id,
                    )
                    writer.last_sent_content = writer.last_content
                    writer.opened = True
                writer.status = "streaming"
            except FeishuCardKitError as error:
                writer.status = "dead"
                logger.warning(
                    "[Feishu] resume after reopen failed: session_id=%s card_id=%s code=%s operation=%s",
                    session_id,
                    card_id,
                    error.code,
                    error.operation,
                )
                if writer.final_requested:
                    writer.status = "finalized"
                    writer.finished = True
                    self._cleanup_stream_state(session_id)
                return

    def _handle_reopen_task_done(self, session_id: str, task: asyncio.Task[None]) -> None:
        if task.cancelled():
            return
        error = task.exception()
        if error is not None:
            logger.warning("[Feishu] reopen task failed: session_id=%s error=%s", session_id, error)
        writer = self._stream_state.get(session_id)
        if writer is not None and writer.reopen_task is task:
            writer.reopen_task = None

    def _cleanup_stream_state(self, session_id: str) -> None:
        self._stream_state.pop(session_id, None)
        self._stream_locks.pop(session_id, None)

    def _run_thread(self) -> None:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        self._loop = loop
        current_thread = threading.current_thread()
        try:
            self._bind_lark_ws_client_loop(loop)
            import lark_oapi as lark
            from lark_oapi.api.im.v1 import P2ImMessageReceiveV1

            handler = (
                lark.EventDispatcherHandler.builder("", "")
                .register_p2_im_message_receive_v1(self._build_message_handler(P2ImMessageReceiveV1))
                .build()
            )
            self._client = lark.ws.Client(
                FEISHU_APP_ID,
                FEISHU_APP_SECRET,
                event_handler=handler,
                log_level=lark.LogLevel.INFO,
                auto_reconnect=True,
            )
            status = feishu_runtime_status()
            logger.info(
                "[Feishu] adapter starting: app_id=%s bot_open_id=%s source=%s",
                status.get("app_id_masked") or "<empty>",
                "set" if self._bot_open_id else "missing",
                self._bot_open_id_source or "none",
            )
            if not self._bot_open_id:
                logger.warning(
                    "[Feishu] bot open id is unavailable; group messages that @ the bot will be ignored"
                )
            self._ready.set()
            self._client.start()
        except BaseException as error:
            if not self._stopping:
                self._start_error = error
            self._ready.set()
            if not self._stopping:
                logger.error("[Feishu] adapter crashed: %s", error, exc_info=True)
        finally:
            pending = [task for task in asyncio.all_tasks(loop) if not task.done()]
            for task in pending:
                task.cancel()
            if pending:
                loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))
            loop.close()
            self._clear_runtime_handles(
                expected_thread=current_thread,
                expected_loop=loop,
                clear_host_loop=True,
            )

    async def _shutdown_loop(self) -> None:
        client = self._client
        if client is not None:
            try:
                await client._disconnect()
            except Exception:
                pass
        current = asyncio.current_task()
        tasks = [task for task in asyncio.all_tasks() if task is not current]
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    @staticmethod
    def _bind_lark_ws_client_loop(loop: asyncio.AbstractEventLoop) -> None:
        client_module = importlib.import_module("lark_oapi.ws.client")
        setattr(client_module, "loop", loop)

    def _clear_runtime_handles(
        self,
        *,
        expected_thread: threading.Thread | None,
        expected_loop: asyncio.AbstractEventLoop | None,
        clear_host_loop: bool,
    ) -> None:
        loop_matches = expected_loop is None or self._loop is expected_loop
        thread_matches = expected_thread is None or self._thread is expected_thread
        if loop_matches:
            self._client = None
            self._loop = None
        if thread_matches:
            self._thread = None
        if clear_host_loop and (loop_matches or thread_matches):
            self._host_loop = None

    def _build_message_handler(self, _event_type):
        def _handle(data) -> None:
            snapshot = self._snapshot_message_event(data)
            if snapshot is None:
                logger.info("[Feishu] skip inbound event without message payload")
                return
            target_loop = self._host_loop
            if target_loop is None or not target_loop.is_running():
                logger.warning(
                    "[Feishu] host loop unavailable; drop inbound message: chat_id=%s msg_id=%s type=%s",
                    str(snapshot.get("chat_id") or "").strip(),
                    str(snapshot.get("message_id") or "").strip(),
                    str(snapshot.get("message_type") or "").strip(),
                )
                return
            future = asyncio.run_coroutine_threadsafe(self._handle_inbound_message(snapshot), target_loop)
            future.add_done_callback(self._log_inbound_future_failure)

        return _handle

    @staticmethod
    def _log_inbound_future_failure(future) -> None:
        try:
            future.result()
        except Exception as exc:
            logger.error("[Feishu] inbound message task failed: %s", exc, exc_info=True)

    @staticmethod
    def _snapshot_message_event(data) -> dict[str, Any] | None:
        event = getattr(data, "event", None)
        message = getattr(event, "message", None)
        if not event or not message:
            return None

        sender = getattr(event, "sender", None)
        sender_id = getattr(sender, "sender_id", None)
        mentions_raw = []
        for mention in list(getattr(message, "mentions", None) or []):
            mention_id = getattr(mention, "id", None)
            mentions_raw.append(
                {
                    "key": str(getattr(mention, "key", "") or "").strip(),
                    "name": str(getattr(mention, "name", "") or "").strip(),
                    "id": {"open_id": str(getattr(mention_id, "open_id", "") or "").strip()},
                }
            )

        return {
            "message_type": str(getattr(message, "message_type", "") or "text").strip() or "text",
            "content": str(getattr(message, "content", "") or "{}"),
            "chat_type": str(getattr(message, "chat_type", "") or "p2p").strip() or "p2p",
            "chat_id": str(getattr(message, "chat_id", "") or "").strip(),
            "message_id": str(getattr(message, "message_id", "") or "").strip(),
            "mentions": mentions_raw,
            "sender_open_id": str(getattr(sender_id, "open_id", "") or "").strip(),
            "sender_user_id": str(getattr(sender_id, "user_id", "") or "").strip(),
        }

    async def _handle_inbound_message(self, snapshot: dict[str, Any]) -> None:
        event = await self._parse_message_event(snapshot)
        if event is not None:
            self.emit(event)

    async def _refresh_bot_identity_if_needed(self) -> None:
        if self._bot_open_id:
            return
        result = await probe_feishu_bot_identity()
        self._last_probe_at = time.time()
        self._last_probe_ok = bool(result.ok)
        if result.ok:
            self._bot_open_id = str(result.bot_open_id or "").strip()
            self._bot_name = str(result.bot_name or "").strip()
            self._bot_open_id_source = "probe"
            logger.info(
                "[Feishu] bot identity probe succeeded: bot_name=%s bot_open_id=%s",
                self._bot_name or "<empty>",
                "set" if self._bot_open_id else "missing",
            )
            return
        logger.warning(
            "[Feishu] bot identity probe failed: app_id=%s error=%s",
            result.app_id or "<empty>",
            result.error or "<empty>",
        )

    async def _parse_message_event(self, snapshot: dict[str, Any]) -> InboundEvent | None:
        data = dict(snapshot or {})
        if not data:
            logger.info("[Feishu] skip inbound event without message payload")
            return None

        message_type = str(data.get("message_type") or "text").strip() or "text"
        raw_content = str(data.get("content") or "{}")
        chat_type = str(data.get("chat_type") or "p2p").strip() or "p2p"
        chat_id = str(data.get("chat_id") or "").strip()
        message_id = str(data.get("message_id") or "").strip()
        mentions_raw = list(data.get("mentions") or [])
        parsed_message = await parse_message_payload_async(
            message_type,
            raw_content,
            message_id=message_id,
            mentions=mentions_raw,
            bot_open_id=self._bot_open_id,
            include_resource_placeholders=False,
            fetch_sub_messages=api_client.get_message_items,
        )
        user_input = parsed_message.text

        if chat_type == "group":
            if not is_bot_mentioned(mentions_raw, self._bot_open_id):
                logger.info(
                    "[Feishu] skip group message without bot mention: chat_id=%s msg_id=%s bot_open_id_configured=%s bot_open_id_source=%s mentions=%d",
                    chat_id,
                    message_id,
                    "yes" if self._bot_open_id else "no",
                    self._bot_open_id_source or "none",
                    len(mentions_raw),
                )
                return None
            user_input = strip_bot_mention(user_input, mentions_raw, self._bot_open_id)

        open_id = ""
        sender_nick = ""
        sender_open_id = str(data.get("sender_open_id") or "").strip()
        sender_user_id = str(data.get("sender_user_id") or "").strip()
        if sender_open_id or sender_user_id:
            open_id = sender_open_id or sender_user_id
            sender_nick = sender_user_id or open_id
        if not open_id:
            logger.warning("[Feishu] skip message without sender open_id: msg_id=%s", message_id)
            return None

        user_content_blocks: list[dict[str, Any]] = []
        resource_metadata: list[dict[str, Any]] = []
        if parsed_message.resources:
            resolved = await resolve_inbound_message(
                message_id=message_id,
                parsed_text=str(user_input or "").strip(),
                resources=list(parsed_message.resources or []),
            )
            user_input = resolved.user_input
            user_content_blocks = list(resolved.user_content_blocks or [])
            resource_metadata = list(resolved.resource_metadata or [])
        else:
            user_input = str(user_input or "").strip()

        if not user_input and not user_content_blocks:
            log_method = logger.warning if parsed_message.resources else logger.info
            log_method(
                "[Feishu] skip inbound message with empty parsed content: chat_id=%s msg_id=%s type=%s",
                chat_id,
                message_id,
                message_type,
            )
            if message_type == "post":
                logger.info(
                    "[Feishu] empty parsed post payload: chat_id=%s msg_id=%s raw_content=%s",
                    chat_id,
                    message_id,
                    raw_content,
                )
            return None

        card_id = uuid.uuid4().hex
        return InboundEvent(
            platform=self.platform,
            connector_key=self.connector_key,
            event_type="agent_message",
            user_input=user_input,
            user_id=open_id,
            card_id=card_id,
            conversation_id=chat_id,
            is_group=(chat_type == "group"),
            message_id=message_id,
            sender_nick=sender_nick,
            raw_data={
                "platform": self.platform,
                "connector_key": self.connector_key,
                "chat_id": chat_id,
                "chat_type": chat_type,
                "message_id": message_id,
                "message_type": message_type,
                "open_id": open_id,
                "resources": resource_metadata,
            },
            user_content_blocks=user_content_blocks,
        )


class FeishuAgentGateway(FeishuStreamAdapter):
    def __init__(self) -> None:
        super().__init__(connector_key="agent")


async def _load_send_context(card_id: str, *, session_id: str = ""):
    card_ctx = await load_card_context(card_id)
    if card_ctx is None:
        raise RuntimeError(f"missing card context: {card_id}")
    connector_key = str(card_ctx.connector_key or "agent").strip() or "agent"
    extra_data = dict(card_ctx.extra_data or {})
    source_message_id = ""
    _ = session_id
    source_message_id = str(extra_data.get("source_message_id") or "").strip()
    return SimpleNamespace(
        platform="feishu",
        connector_key=connector_key,
        card_id=card_id,
        out_track_id=card_id,
        platform_message_id=str(card_ctx.platform_message_id or "").strip(),
        owner_user_id=str(card_ctx.owner_user_id or "").strip(),
        conversation_id=str(card_ctx.conversation_id or "").strip(),
        conversation_type=str(card_ctx.conversation_type or "").strip(),
        sender_nick=str(card_ctx.sender_nick or "").strip(),
        message_id=source_message_id,
        extra_data=extra_data,
        raw_data={
            "platform": "feishu",
            "connector_key": connector_key,
            "chat_id": str(card_ctx.conversation_id or "").strip(),
            "source_message_id": source_message_id,
        },
    )
