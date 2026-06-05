from __future__ import annotations

import uuid
from typing import Any

from gateway.channel_registry import ChannelRegistry
from gateway.models import InboundEvent, LaneKey, OutboundRequest, RouteDecision
from gateway.session_scheduler import SessionScheduler
from shared.agent_io import AgentJob
from shared.agent_sessions import AgentSessionStatus
from shared.agent_state import build_initial_agent_state
from shared.db.client import (
    create_agent_session,
    create_card_context,
    load_agent_session,
    pop_agent_session_pending_events,
    update_agent_session,
)
from shared.logging import logger
from shared.permission_policy import (
    bot_key_for_bot_id,
    can_user_access_bot,
    is_known_bot_id,
    resolve_bot_id,
    resolve_permission_user_id,
)
from shared.platform.context import SessionContext
from shared.session_bindings import SessionBindingStore, SessionSource


_CONTROL_COMMANDS = {
    "/stop": "stop",
    "/clear": "clear",
}


def _normalize_control_command(text: str) -> str:
    normalized = str(text or "").strip()
    if not normalized:
        return ""
    normalized = normalized.replace("／", "/", 1)
    command = normalized.split(maxsplit=1)[0].lower()
    return _CONTROL_COMMANDS.get(command, "")


def _source_from_event(event: InboundEvent) -> SessionSource:
    raw = dict(event.source or {})
    raw.setdefault("platform", str(event.platform or "").strip())
    raw.setdefault("chat_id", str(event.conversation_id or "").strip())
    raw.setdefault("chat_type", "group" if bool(event.is_group) else "dm")
    raw.setdefault("user_id", str(event.user_id or "").strip())
    if str(event.union_id or "").strip() and not str(raw.get("user_id_alt") or "").strip():
        raw["user_id_alt"] = str(event.union_id or "").strip()
    raw.setdefault("user_name", str(event.sender_nick or "").strip())
    raw.setdefault("message_id", str(event.message_id or "").strip())
    return SessionSource.from_dict(raw)


def _to_session_context(
    event: InboundEvent,
    *,
    source: SessionSource,
    session_key: str,
) -> SessionContext:
    source_dict = source.to_dict()
    return SessionContext(
        platform=str(source.platform or event.platform or "").strip(),
        user_input=str(event.user_input or "").strip(),
        user_id=str(source.user_key or event.user_id or "").strip(),
        card_id=str(event.card_id or "").strip() or uuid.uuid4().hex,
        conversation_id=str(source.chat_id or event.conversation_id or "").strip(),
        is_group=str(source.chat_type or "").strip().lower() == "group",
        message_id=str(event.message_id or source.message_id or "").strip(),
        sender_nick=str(source.user_name or event.sender_nick or "").strip(),
        session_key=session_key,
        source=source_dict,
        raw_data=dict(event.raw_data or {}),
        user_content_blocks=list(event.user_content_blocks or []),
    )


def _merge_job_raw_data(ctx: SessionContext, pending_events: list[dict[str, Any]]) -> dict[str, Any]:
    raw_data = {
        **dict(ctx.raw_data or {}),
        "session_key": str(ctx.session_key or "").strip(),
        "source": dict(ctx.source or {}),
    }
    if pending_events:
        raw_data["system_events"] = pending_events
    return raw_data


class SessionRouter:
    def __init__(self, *, registry: ChannelRegistry) -> None:
        self._registry = registry
        self._bindings = SessionBindingStore()
        self._scheduler: SessionScheduler | None = None

    def bind_scheduler(self, scheduler: SessionScheduler) -> None:
        self._scheduler = scheduler

    async def route_message(self, event: InboundEvent) -> RouteDecision:
        if self._scheduler is None:
            raise RuntimeError("session scheduler not configured")

        source = _source_from_event(event)
        session_key = source.session_key
        ctx = _to_session_context(event, source=source, session_key=session_key)
        union_id = resolve_permission_user_id(event)
        lane = LaneKey(
            platform=ctx.platform,
            owner_id=session_key,
            scope="agent",
        ).as_key()

        logger.info(
            "[SessionRouter] inbound event: platform=%s session_key=%s chat=%s chat_type=%s msg_id=%s user_id=%s union_id=%s text=%s",
            ctx.platform,
            session_key,
            ctx.conversation_id,
            dict(ctx.source or {}).get("chat_type") or "",
            ctx.message_id,
            ctx.user_id,
            union_id,
            str(ctx.user_input or "")[:120],
        )

        bot_id = resolve_bot_id(event)
        bot_key = bot_key_for_bot_id(bot_id)
        if not is_known_bot_id(bot_id):
            logger.warning(
                "[SessionRouter] permission denied: unknown bot platform=%s bot_id=%s user_id=%s union_id=%s",
                ctx.platform,
                bot_id or "<empty>",
                ctx.user_id,
                union_id,
            )
            await self._send_permission_feedback(ctx, markdown="当前 Bot 未授权接入 Agent。")
            return RouteDecision(route_kind="permission_denied", lane_key=lane, platform=ctx.platform)
        if not can_user_access_bot(union_id, bot_id):
            logger.warning(
                "[SessionRouter] permission denied: user cannot access bot platform=%s bot_id=%s bot=%s user_id=%s union_id=%s",
                ctx.platform,
                bot_id,
                bot_key or "<unknown>",
                ctx.user_id,
                union_id,
            )
            await self._send_permission_feedback(ctx, markdown="你没有权限使用当前 Agent。")
            return RouteDecision(route_kind="permission_denied", lane_key=lane, platform=ctx.platform)

        control_command = _normalize_control_command(ctx.user_input)
        if control_command:
            session = await self._load_bound_session(ctx)
            await self._handle_control_command(control_command, session=session, ctx=ctx)
            return RouteDecision(route_kind="agent_control", lane_key=lane, platform=ctx.platform)

        session = await self._load_or_create_bound_session(ctx)
        pending_events = await pop_agent_session_pending_events(session.session_id)
        job = AgentJob(
            job_id=uuid.uuid4().hex,
            session_id=session.session_id,
            session_key=ctx.session_key,
            card_id=ctx.card_id,
            user_id=ctx.user_id,
            conversation_id=ctx.conversation_id,
            is_group=ctx.is_group,
            message_id=ctx.message_id,
            user_input=ctx.user_input,
            job_kind="turn",
            sender_nick=ctx.sender_nick,
            raw_data=_merge_job_raw_data(ctx, pending_events),
            source=dict(ctx.source or {}),
            user_content_blocks=list(ctx.user_content_blocks or []),
        )
        await self._scheduler.enqueue(job)
        return RouteDecision(route_kind="agent_message", lane_key=lane, platform=ctx.platform)

    async def _handle_control_command(self, command: str, *, session, ctx: SessionContext) -> None:
        if command == "stop":
            await self._handle_stop(session=session, ctx=ctx)
            return
        await self._handle_clear(session=session, ctx=ctx)

    async def _handle_stop(self, *, session, ctx: SessionContext) -> None:
        if session is None:
            logger.info(
                "[SessionRouter] stop without session: session_key=%s card_id=%s message_id=%s",
                ctx.session_key,
                ctx.card_id,
                ctx.message_id,
            )
            await self._send_control_feedback(ctx, session_id="", markdown="当前没有正在执行的回复。")
            return

        session_id = str(session.session_id or "").strip()
        stopped = self._scheduler.request_stop(session_id) if self._scheduler is not None else False
        logger.info("[SessionRouter] stop: session_id=%s stopped=%s", session_id, stopped)
        if not stopped:
            message = "当前没有正在执行的回复。"
        else:
            message = "已请求停止当前回复。"
        await self._send_control_feedback(ctx, session_id=session_id, markdown=message)

    async def _handle_clear(self, *, session, ctx: SessionContext) -> None:
        if session is not None:
            session_id = str(session.session_id or "").strip()
            if self._scheduler is not None and self._scheduler.has_inflight_work(session_id):
                logger.info(
                    "[SessionRouter] clear refused: session_id=%s reason=inflight_work",
                    session_id,
                )
                await self._send_control_feedback(
                    ctx,
                    session_id=session_id,
                    markdown="当前有进行中的回复，暂不创建新会话。",
                )
                return

        new_session = await self._rotate_session(ctx)
        logger.info(
            "[SessionRouter] clear created new session: session_key=%s session_id=%s",
            ctx.session_key,
            new_session.session_id,
        )
        await self._send_control_feedback(
            ctx,
            session_id=new_session.session_id,
            markdown="已创建新会话。",
        )

    async def _send_permission_feedback(self, ctx: SessionContext, *, markdown: str) -> None:
        await self._send_control_feedback(ctx, session_id="", markdown=markdown)

    async def _load_bound_session(self, ctx: SessionContext):
        entry = self._bindings.get(ctx.session_key)
        if entry is None or not str(entry.session_id or "").strip():
            return None
        return await load_agent_session(entry.session_id)

    async def _load_or_create_bound_session(self, ctx: SessionContext):
        entry = self._bindings.get_or_create(SessionSource.from_dict(ctx.source))
        session = await load_agent_session(entry.session_id)
        if session is None:
            return await self._create_session(ctx, session_id=entry.session_id)
        return await self._rebind_session(session, ctx)

    async def _rotate_session(self, ctx: SessionContext):
        entry = self._bindings.rotate(SessionSource.from_dict(ctx.source))
        return await self._create_session(ctx, session_id=entry.session_id)

    @staticmethod
    async def _rebind_session(session, ctx: SessionContext):
        await create_card_context(ctx)
        refreshed = await update_agent_session(
            session.session_id,
            source=dict(ctx.source or {}),
        )
        if refreshed is None:
            return session
        logger.info(
            "[SessionRouter] rebound session source: session=%s session_key=%s card=%s",
            refreshed.session_id,
            ctx.session_key,
            ctx.card_id,
        )
        return refreshed

    @staticmethod
    async def _create_session(ctx: SessionContext, *, session_id: str):
        await create_card_context(ctx)
        session = await create_agent_session(
            source=dict(ctx.source or {}),
            status=AgentSessionStatus.WAITING_USER_INPUT,
            state_data=build_initial_agent_state(entry_text=ctx.user_input),
            session_id=session_id,
        )
        logger.info(
            "[SessionRouter] created session: platform=%s session_key=%s session=%s",
            ctx.platform,
            ctx.session_key,
            session.session_id,
        )
        return session

    async def _send_control_feedback(
        self,
        ctx: SessionContext,
        *,
        session_id: str,
        markdown: str,
    ) -> None:
        await create_card_context(ctx)
        platform = str(ctx.platform or "").strip()
        adapter = self._registry.get(platform)
        await adapter.handle_outbound(
            OutboundRequest(
                action="send_message",
                platform=platform,
                payload={"markdown": str(markdown or "")},
                session_id=str(session_id or "").strip(),
                card_id=str(ctx.card_id or "").strip(),
                event_id=uuid.uuid4().hex,
            )
        )
