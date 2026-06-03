from __future__ import annotations

import uuid

from gateway.channel_registry import ChannelRegistry
from gateway.models import InboundEvent, LaneKey, OutboundRequest, RouteDecision
from gateway.session_scheduler import SessionScheduler
from shared.agent_ipc import AgentJob
from shared.agent_sessions import AgentSessionStatus
from shared.agent_state import build_initial_agent_state, runtime_state
from shared.db.client import (
    pop_agent_session_pending_events,
    clear_agent_session_memory,
    create_agent_session,
    create_card_context,
    load_active_agent_session_by_user,
    load_agent_session,
    load_latest_agent_session_for_conversation,
    request_agent_turn_stop,
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


def _to_session_context(event: InboundEvent) -> SessionContext:
    return SessionContext(
        platform=str(event.platform or "").strip(),
        connector_key=str(event.connector_key or "").strip(),
        user_input=str(event.user_input or "").strip(),
        user_id=str(event.user_id or "").strip(),
        card_id=str(event.card_id or "").strip() or uuid.uuid4().hex,
        conversation_id=str(event.conversation_id or "").strip(),
        is_group=bool(event.is_group),
        message_id=str(event.message_id or "").strip(),
        sender_nick=str(event.sender_nick or "").strip(),
        raw_data=dict(event.raw_data or {}),
        user_content_blocks=list(event.user_content_blocks or []),
    )


class SessionRouter:
    def __init__(self, *, registry: ChannelRegistry) -> None:
        self._registry = registry
        self._scheduler: SessionScheduler | None = None

    def bind_scheduler(self, scheduler: SessionScheduler) -> None:
        self._scheduler = scheduler

    async def route_message(self, event: InboundEvent) -> RouteDecision:
        if self._scheduler is None:
            raise RuntimeError("session scheduler not configured")
        union_id = resolve_permission_user_id(event)
        logger.info(
            "[SessionRouter] inbound event: platform=%s connector=%s conversation=%s is_group=%s msg_id=%s user_id=%s union_id=%s text=%s",
            event.platform,
            event.connector_key,
            event.conversation_id,
            event.is_group,
            event.message_id,
            event.user_id,
            union_id,
            str(event.user_input or "")[:120],
        )
        lane = LaneKey(
            platform=event.platform,
            connector_key=event.connector_key,
            owner_id=event.user_id,
            scope="agent",
        ).as_key()
        ctx = _to_session_context(event)
        bot_id = resolve_bot_id(event)
        bot_key = bot_key_for_bot_id(bot_id)
        if not is_known_bot_id(bot_id):
            logger.warning(
                "[SessionRouter] permission denied: unknown bot platform=%s connector=%s bot_id=%s user_id=%s union_id=%s",
                ctx.platform,
                ctx.connector_key,
                bot_id or "<empty>",
                ctx.user_id,
                union_id,
            )
            await self._send_permission_feedback(ctx, markdown="当前 Bot 未授权接入 Agent。")
            return RouteDecision(
                route_kind="permission_denied",
                lane_key=lane,
                connector_key=event.connector_key,
                platform=event.platform,
            )
        if not can_user_access_bot(union_id, bot_id):
            logger.warning(
                "[SessionRouter] permission denied: user cannot access bot platform=%s connector=%s bot_id=%s bot=%s user_id=%s union_id=%s",
                ctx.platform,
                ctx.connector_key,
                bot_id,
                bot_key or "<unknown>",
                ctx.user_id,
                union_id,
            )
            await self._send_permission_feedback(ctx, markdown="你没有权限使用当前 Agent。")
            return RouteDecision(
                route_kind="permission_denied",
                lane_key=lane,
                connector_key=event.connector_key,
                platform=event.platform,
            )
        control_command = _normalize_control_command(ctx.user_input)
        if control_command:
            session = await self._load_control_session(ctx)
            await self._handle_control_command(control_command, session=session, ctx=ctx)
            return RouteDecision(
                route_kind="agent_control",
                lane_key=lane,
                connector_key=event.connector_key,
                platform=event.platform,
            )

        session = await self._load_session(ctx)
        if session is None:
            session = await self._create_session(ctx)
        else:
            session = await self._rebind_session(session, ctx)
        pending_events = []
        if session is not None:
            pending_events = await pop_agent_session_pending_events(session.session_id)
        job = AgentJob(
            job_id=uuid.uuid4().hex,
            session_id=session.session_id,
            platform=session.platform,
            connector_key=session.connector_key,
            user_id=session.owner_user_id,
            conversation_id=str(session.conversation_id or "").strip(),
            is_group=bool(str(session.conversation_type or "").strip() == "2"),
            message_id=ctx.message_id,
            user_input=ctx.user_input,
            job_kind="turn",
            sender_nick=str(session.sender_nick or ctx.sender_nick or "").strip(),
            raw_data={
                **dict(ctx.raw_data or {}),
                **({"system_events": pending_events} if pending_events else {}),
            },
            user_content_blocks=list(ctx.user_content_blocks or []),
        )
        await self._scheduler.enqueue(job)
        return RouteDecision(
            route_kind="agent_message",
            lane_key=lane,
            connector_key=event.connector_key,
            platform=event.platform,
        )

    async def _handle_control_command(self, command: str, *, session, ctx: SessionContext) -> None:
        if session is None:
            fallback = await load_active_agent_session_by_user(
                ctx.user_id,
                platform=ctx.platform,
                connector_key=ctx.connector_key,
            )
            if fallback is not None:
                logger.warning(
                    "[SessionRouter] control command fallback: conversation lookup missed but user lookup found session. "
                    "command=%s conversation_id=%s user_id=%s fallback_session=%s",
                    command,
                    ctx.conversation_id,
                    ctx.user_id,
                    fallback.session_id,
                )
                session = fallback
        if session is None:
            message = "当前没有正在执行的回复。" if command == "stop" else "上下文已清除。"
            logger.info(
                "[SessionRouter] %s without session: user_id=%s conversation_id=%s card_id=%s message_id=%s",
                command,
                ctx.user_id,
                ctx.conversation_id,
                ctx.card_id,
                ctx.message_id,
            )
            await self._send_control_feedback(ctx, session_id="", markdown=message)
            return

        session_id = str(session.session_id or "").strip()

        if command == "stop":
            fresh = await load_agent_session(session_id)
            runtime = runtime_state(getattr(fresh or session, "state_data", {}) or {})
            active_turn_id = str(runtime.get("active_turn_id") or "").strip()
            logger.info(
                "[SessionRouter] stop: session_id=%s active_turn_id=%s",
                session_id,
                active_turn_id,
            )
            if not active_turn_id:
                message = "当前没有正在执行的回复。"
            else:
                await request_agent_turn_stop(
                    session_id,
                    turn_id=active_turn_id,
                    reason="slash_command_stop",
                )
                message = "已请求停止当前回复。"
        else:
            rebound_session = await self._rebind_session(session, ctx)
            runtime = runtime_state(getattr(rebound_session, "state_data", {}) or {})
            active_turn_id = str(runtime.get("active_turn_id") or "").strip()
            logger.info(
                "[SessionRouter] clear: session_id=%s active_turn_id=%s",
                session_id,
                active_turn_id,
            )
            if active_turn_id:
                message = "当前有进行中的回复，暂不清除上下文。"
            else:
                await clear_agent_session_memory(
                    session_id,
                    reason="slash_command_clear",
                )
                message = "上下文已清除。"
        await self._send_control_feedback(ctx, session_id=session_id, markdown=message)

    async def _send_permission_feedback(self, ctx: SessionContext, *, markdown: str) -> None:
        await self._send_control_feedback(ctx, session_id="", markdown=markdown)

    @staticmethod
    async def _load_session(ctx: SessionContext):
        return await load_active_agent_session_by_user(
            ctx.user_id,
            platform=ctx.platform,
            connector_key=ctx.connector_key,
        )

    @staticmethod
    async def _load_control_session(ctx: SessionContext):
        return await load_latest_agent_session_for_conversation(
            ctx.conversation_id,
            ctx.user_id,
            platform=ctx.platform,
            connector_key=ctx.connector_key,
        )

    @staticmethod
    async def _rebind_session(session, ctx: SessionContext):
        await create_card_context(ctx)
        refreshed = await update_agent_session(
            session.session_id,
            card_id=ctx.card_id,
            conversation_id=ctx.conversation_id,
            conversation_type="2" if ctx.is_group else "1",
            sender_nick=ctx.sender_nick,
        )
        if refreshed is None:
            return session
        logger.info(
            "[SessionRouter] rebound session target: session=%s user=%s conversation=%s card=%s",
            refreshed.session_id,
            ctx.user_id,
            ctx.conversation_id,
            ctx.card_id,
        )
        return refreshed

    @staticmethod
    async def _create_session(ctx: SessionContext):
        await create_card_context(ctx)
        session = await create_agent_session(
            card_id=ctx.card_id,
            owner_user_id=ctx.user_id,
            conversation_id=ctx.conversation_id,
            conversation_type="2" if ctx.is_group else "1",
            sender_nick=ctx.sender_nick,
            platform=ctx.platform,
            connector_key=ctx.connector_key,
            status=AgentSessionStatus.WAITING_USER_INPUT,
            state_data=build_initial_agent_state(
                entry_text=ctx.user_input,
            ),
            session_id="",
        )
        logger.info(
            "[SessionRouter] created session: platform=%s connector=%s user=%s conversation=%s session=%s",
            ctx.platform,
            ctx.connector_key,
            ctx.user_id,
            ctx.conversation_id,
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
        connector_key = str(ctx.connector_key or "").strip()
        adapter = self._registry.get(platform, connector_key)
        await adapter.handle_outbound(
            OutboundRequest(
                action="send_message",
                platform=platform,
                connector_key=connector_key,
                payload={"markdown": str(markdown or "")},
                session_id=str(session_id or "").strip(),
                card_id=str(ctx.card_id or "").strip(),
                event_id=uuid.uuid4().hex,
            )
        )
