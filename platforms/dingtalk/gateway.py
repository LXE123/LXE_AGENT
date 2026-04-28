from __future__ import annotations

import asyncio
import json
import threading
import uuid
from concurrent.futures import Future
from types import SimpleNamespace
from typing import Any

import dingtalk_stream
from dingtalk_stream import AckMessage, CallbackHandler, CallbackMessage, ChatbotHandler

from gateway.models import CallbackEvent, InboundEvent, OutboundRequest
from shared.db.client import load_card_context
from shared.dingtalk.card.runtime.card_builder import CardBuilder
from shared.dingtalk.credentials import agent_connector_key, inject_bot_data, normalize_bot_name
from shared.logging import logger
from shared.platform.adapter import InboundSink

from .card_sender import DingTalkCardSender
from .media_sender import DingTalkMediaSender


def _build_message_key(callback: CallbackMessage, fallback: str) -> str:
    raw = dict(getattr(callback, "data", {}) or {})
    headers = getattr(callback, "headers", None)
    header_message_id = str(getattr(headers, "message_id", "") or "").strip()
    return str(raw.get("msgId") or "").strip() or header_message_id or fallback


def _extract_callback_params(data: dict[str, Any]) -> dict[str, Any]:
    try:
        content = data.get("content", {})
        if isinstance(content, str):
            content = json.loads(content)
        return dict(content.get("cardPrivateData", {}).get("params", {}) or {})
    except Exception:
        return {}


class _MessageHandler(ChatbotHandler):
    def __init__(self, adapter: "DingTalkStreamAdapter") -> None:
        self._adapter = adapter

    async def process(self, callback: CallbackMessage):
        event = self._adapter.build_message_event(callback)
        if event is not None:
            self._adapter.emit(event)
        return AckMessage.STATUS_OK, "OK"


class _CardCallbackHandler(CallbackHandler):
    def __init__(self, adapter: "DingTalkStreamAdapter") -> None:
        self._adapter = adapter

    async def process(self, callback: CallbackMessage):
        event = self._adapter.build_callback_event(callback)
        payload = self._adapter.emit(event) or {
            "button1_status": "disabled",
            "button2_status": "disabled",
            "button3_status": "disabled",
        }
        return AckMessage.STATUS_OK, CardBuilder.create_general_card_callback_response(payload)


class DingTalkStreamAdapter:
    platform = "dingtalk"

    def __init__(
        self,
        *,
        connector_key: str,
        client_id: str,
        client_secret: str,
        enable_card_callbacks: bool = False,
    ) -> None:
        self.connector_key = str(connector_key or "").strip()
        self._client_id = str(client_id or "").strip()
        self._client_secret = str(client_secret or "").strip()
        self._enable_card_callbacks = bool(enable_card_callbacks)
        self._inbound_sink: InboundSink | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._thread: threading.Thread | None = None
        self._client: dingtalk_stream.DingTalkStreamClient | None = None
        self._card_sender = DingTalkCardSender()
        self._media_sender = DingTalkMediaSender()
        self._ready = threading.Event()
        self._stopped = threading.Event()
        self._start_error: BaseException | None = None
        self._stopping = False

    def set_inbound_sink(self, sink: InboundSink) -> None:
        self._inbound_sink = sink

    def _connection_health(self) -> tuple[bool, str]:
        thread_alive = bool(self._thread and self._thread.is_alive())
        websocket = getattr(self._client, "websocket", None) if self._client is not None else None
        connection_alive = bool(websocket is not None and not getattr(websocket, "closed", True))
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
        }

    async def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        if self._inbound_sink is None:
            raise RuntimeError(f"inbound sink not configured for dingtalk:{self.connector_key}")

        self._clear_runtime_handles(
            expected_thread=self._thread,
            expected_loop=self._loop,
        )
        self._ready.clear()
        self._stopped.clear()
        self._start_error = None
        self._stopping = False
        self._thread = threading.Thread(
            target=self._run_thread,
            name=f"adapter:dingtalk:{self.connector_key}",
            daemon=True,
        )
        self._thread.start()
        await asyncio.to_thread(self._ready.wait, 15)
        if self._start_error is not None:
            raise RuntimeError(f"dingtalk adapter failed: {self._start_error}") from self._start_error

    async def stop(self) -> None:
        thread = self._thread
        loop = self._loop
        if thread is None or not thread.is_alive():
            self._clear_runtime_handles(
                expected_thread=thread,
                expected_loop=loop,
            )
            return
        self._stopping = True
        if loop is not None and not loop.is_closed():
            future: Future | None = None
            try:
                future = asyncio.run_coroutine_threadsafe(self._shutdown_loop(), loop)
            except RuntimeError:
                future = None
            if future is not None:
                try:
                    await asyncio.wait_for(asyncio.wrap_future(future), timeout=5.0)
                except BaseException:
                    pass
            try:
                loop.call_soon_threadsafe(loop.stop)
            except RuntimeError:
                pass
        await asyncio.to_thread(thread.join, 5)
        if thread.is_alive():
            raise RuntimeError(f"dingtalk adapter thread did not stop: {thread.name}")
        self._clear_runtime_handles(
            expected_thread=thread,
            expected_loop=loop,
        )

    async def handle_outbound(self, request: OutboundRequest) -> None:
        card_ctx = await _load_send_context(request.card_id)
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
            raise RuntimeError("empty dingtalk send_message payload")
        if request.action == "send_file":
            path = str(request.payload.get("path") or "").strip()
            if not path:
                raise RuntimeError("missing file path")
            sent = await self._media_sender.send_file(card_ctx, path)
            if sent:
                return
            raise RuntimeError(f"dingtalk file send failed: {path}")
        if request.action == "react":
            logger.info("[DingTalk] ignore unsupported react action for connector=%s", self.connector_key)
            return
        raise RuntimeError(f"unsupported outbound action: {request.action}")

    def build_message_event(self, callback: CallbackMessage) -> InboundEvent | None:
        raw = inject_bot_data(getattr(callback, "data", {}) or {}, self.connector_key)
        user_input = str(((raw.get("text") or {}).get("content") or "")).strip()
        if not user_input:
            return None
        card_id = uuid.uuid4().hex
        message_id = _build_message_key(callback, card_id)
        return InboundEvent(
            platform=self.platform,
            connector_key=self.connector_key,
            event_type=f"{self.connector_key}_message",
            user_input=user_input,
            user_id=str(raw.get("senderStaffId") or raw.get("senderId") or "").strip(),
            card_id=card_id,
            conversation_id=str(raw.get("conversationId") or "").strip(),
            is_group=str(raw.get("conversationType") or "") == "2",
            message_id=message_id,
            sender_nick=str(raw.get("senderNick") or "未知用户").strip(),
            raw_data=raw,
        )

    def build_callback_event(self, callback: CallbackMessage) -> CallbackEvent:
        data = dict(getattr(callback, "data", {}) or {})
        params = _extract_callback_params(data)
        headers = getattr(callback, "headers", None)
        message_id = (
            str(data.get("msgId") or "").strip()
            or str(getattr(headers, "message_id", "") or "").strip()
            or "unknown"
        )
        callback_id = str(
            params.get("button1_callback")
            or params.get("button2_callback")
            or params.get("button3_callback")
            or params.get("sayback_doing")
            or params.get("sayback_onging")
            or params.get("sayback")
            or params.get("input")
            or message_id
        )[:80]
        return CallbackEvent(
            platform=self.platform,
            connector_key=self.connector_key,
            out_track_id=str(data.get("outTrackId") or "").strip(),
            message_id=message_id,
            user_id=str(data.get("userId") or data.get("senderStaffId") or "").strip(),
            raw_data=data,
            params=params,
            callback_id=callback_id,
        )

    def emit(self, event: InboundEvent | CallbackEvent) -> Any:
        if self._inbound_sink is None:
            raise RuntimeError(f"inbound sink not configured for dingtalk:{self.connector_key}")
        return self._inbound_sink(event)

    async def _shutdown_loop(self) -> None:
        client = self._client
        websocket = getattr(client, "websocket", None) if client is not None else None
        if websocket is not None and not getattr(websocket, "closed", False):
            try:
                await websocket.close()
            except Exception:
                pass
        current = asyncio.current_task()
        for task in list(asyncio.all_tasks()):
            if task is current:
                continue
            task.cancel()
        await asyncio.gather(
            *[task for task in asyncio.all_tasks() if task is not current],
            return_exceptions=True,
        )

    def _build_client(self) -> dingtalk_stream.DingTalkStreamClient:
        credential = dingtalk_stream.Credential(self._client_id, self._client_secret)
        client = dingtalk_stream.DingTalkStreamClient(credential)
        client.register_callback_handler(
            dingtalk_stream.chatbot.ChatbotMessage.TOPIC,
            _MessageHandler(self),
        )
        if self._enable_card_callbacks:
            client.register_callback_handler(
                dingtalk_stream.CallbackHandler.TOPIC_CARD_CALLBACK,
                _CardCallbackHandler(self),
            )
        return client

    def _run_thread(self) -> None:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        self._loop = loop
        current_thread = threading.current_thread()
        try:
            self._client = self._build_client()
            self._ready.set()
            logger.info("[DingTalk] adapter starting: connector=%s", self.connector_key)
            loop.run_until_complete(self._client.start())
        except BaseException as error:
            if not self._stopping:
                self._start_error = error
            self._ready.set()
            if not self._stopping and not isinstance(error, asyncio.CancelledError):
                logger.error("[DingTalk] adapter crashed: connector=%s error=%s", self.connector_key, error, exc_info=True)
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
            )
            self._stopped.set()

    def _clear_runtime_handles(
        self,
        *,
        expected_thread: threading.Thread | None,
        expected_loop: asyncio.AbstractEventLoop | None,
    ) -> None:
        loop_matches = expected_loop is None or self._loop is expected_loop
        thread_matches = expected_thread is None or self._thread is expected_thread
        if loop_matches:
            self._client = None
            self._loop = None
        if thread_matches:
            self._thread = None


class DingTalkAgentGateway(DingTalkStreamAdapter):
    def __init__(self, client_id: str, client_secret: str) -> None:
        super().__init__(connector_key=agent_connector_key(), client_id=client_id, client_secret=client_secret)


async def _load_send_context(card_id: str):
    card_ctx = await load_card_context(card_id)
    if card_ctx is None:
        raise RuntimeError(f"missing card context: {card_id}")
    extra_data = dict(getattr(card_ctx, "extra_data", {}) or {})
    bot_name = normalize_bot_name(
        card_ctx.connector_key
        or extra_data.get("connector_key")
        or extra_data.get("bot_name")
        or extra_data.get("robot_code"),
        default="agent",
    )
    return SimpleNamespace(
        card_id=card_id,
        out_track_id=card_id,
        connector_key=bot_name,
        owner_user_id=str(card_ctx.owner_user_id or "").strip(),
        conversation_id=str(card_ctx.conversation_id or "").strip(),
        conversation_type=str(card_ctx.conversation_type or "").strip(),
        sender_nick=str(card_ctx.sender_nick or "").strip(),
        extra_data=extra_data,
        raw_data={
            "conversationId": str(card_ctx.conversation_id or "").strip(),
            "conversationType": str(card_ctx.conversation_type or "").strip(),
            "senderStaffId": str(card_ctx.owner_user_id or "").strip(),
            "senderId": str(card_ctx.owner_user_id or "").strip(),
            "userId": str(card_ctx.owner_user_id or "").strip(),
            "senderNick": str(card_ctx.sender_nick or "").strip(),
            "_bot_name": bot_name,
            "robotCode": str(extra_data.get("robot_code") or bot_name).strip(),
        },
    )
