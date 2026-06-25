"""Agent turn execution handlers for the root gateway runtime."""
from __future__ import annotations

import time
from collections.abc import Awaitable, Callable
from typing import Any
from uuid import uuid4

from agent_runtime.emit_bus import emit_final as default_emit_final
from agent_runtime.emit_bus import emit_stream as default_emit_stream
from shared.db.client import (
    append_agent_session_message,
    load_agent_session,
    pop_agent_session_pending_events,
    update_agent_session,
)
from shared.logging import logger
from shared.runtime_core.outcome import job_handled

from .final_answer_streamer import FinalAnswerStreamer
from .runtime import run_turn
from .types import TurnOutcome

FinalEmitter = Callable[..., Awaitable[None]]
StreamEmitter = Callable[..., Awaitable[None]]
TypingIndicatorEmitter = Callable[..., Awaitable[None]]
_CHECKPOINT_APPEND_MESSAGE = "append_message"
_CHECKPOINT_SNAPSHOT = "snapshot"


def _sanitize_system_prefixed_text(text: str) -> str:
    lines = []
    for line in str(text or "").splitlines():
        if line.startswith("System:"):
            lines.append(line.replace("System:", "System (untrusted):", 1))
        else:
            lines.append(line)
    return "\n".join(lines)


def _normalize_system_events(raw_events: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    return [dict(item) for item in list(raw_events or []) if isinstance(item, dict)]


def _format_system_events(events: list[dict[str, Any]]) -> str:
    parts: list[str] = []
    for event in events:
        created_at = int(event.get("created_at") or 0)
        prefix_time = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(created_at)) if created_at else ""
        prefix = f"System: [{prefix_time}] " if prefix_time else "System: "
        body = str(event.get("text") or "").strip()
        if body:
            parts.append(prefix + body)
    return "\n\n".join(parts).strip()


def _prepend_system_events_to_blocks(
    blocks: list[dict[str, Any]],
    *,
    system_events_text: str,
) -> list[dict[str, Any]]:
    sanitized_blocks: list[dict[str, Any]] = []
    for block in list(blocks or []):
        current = dict(block or {})
        if str(current.get("type") or "").strip() == "text":
            current["text"] = _sanitize_system_prefixed_text(str(current.get("text") or ""))
        sanitized_blocks.append(current)
    if not system_events_text:
        return sanitized_blocks
    return [{"type": "text", "text": system_events_text}, *sanitized_blocks]


def _should_stream_final_answer(session: Any) -> bool:
    source = dict(getattr(session, "source", {}) or {})
    return str(source.get("platform") or "").strip() == "feishu"


def _should_emit_typing_indicator(
    session: Any,
    *,
    job_kind: str,
    raw_data: dict[str, Any],
    response_route_id: str,
) -> bool:
    if str(job_kind or "").strip() != "turn":
        return False
    if not str(response_route_id or "").strip():
        return False
    if bool(raw_data.get("skip_typing")):
        return False
    source = dict(getattr(session, "source", {}) or {})
    return str(source.get("platform") or "").strip() == "feishu"


async def _emit_typing_indicator_best_effort(
    emit_typing_indicator_fn: TypingIndicatorEmitter | None,
    *,
    session_id: str,
    response_route_id: str,
    operation: str,
) -> None:
    if emit_typing_indicator_fn is None:
        return
    try:
        await emit_typing_indicator_fn(
            session_id=session_id,
            response_route_id=response_route_id,
            operation=operation,
            emit_id=uuid4().hex,
        )
    except Exception as exc:
        logger.warning("[TurnHandler] typing indicator %s failed: %s", operation, exc)


async def _turn_cancel_requested(session_id: str, job_id: str) -> bool:
    safe_session_id = str(session_id or "").strip()
    safe_job_id = str(job_id or "").strip()
    if not safe_session_id or not safe_job_id:
        return False

    latest = await load_agent_session(safe_session_id)
    if not latest:
        return True

    return False


async def _emit_final_answer_stream_frame(
    session_id: str,
    response_route_id: str,
    stream_type: str,
    state: str,
    seq: int,
    content: str,
    emit_id: str,
    *,
    thinking: str = "",
    redacted_thinking_count: int = 0,
    thinking_elapsed_ms: int = 0,
    tool_pending: bool = False,
    tool_elapsed_ms: int = 0,
    tool_steps: list[dict[str, Any]] | None = None,
) -> None:
    await default_emit_stream(
        session_id=session_id,
        response_route_id=response_route_id,
        stream_type=stream_type,
        state=state,
        seq=seq,
        content=content,
        thinking=thinking,
        redacted_thinking_count=redacted_thinking_count,
        thinking_elapsed_ms=thinking_elapsed_ms,
        tool_pending=tool_pending,
        tool_elapsed_ms=tool_elapsed_ms,
        tool_steps=tool_steps,
        emit_id=emit_id,
    )


async def _persist_and_deliver(
    session: Any,
    outcome: TurnOutcome,
    *,
    response_route_id: str,
    emit_final_fn: FinalEmitter,
    skip_emit_final: bool = False,
    title_candidate: str = "",
) -> None:
    session_id = str(getattr(session, "session_id", "") or "").strip()

    message = str(outcome.reply or "").strip()
    state_patch = dict(outcome.state_data_patch or {})
    turn_log = outcome.turn_log
    metrics_delta = {
        "api_call_count": int(getattr(turn_log, "total_llm_calls", 0) or 0),
        "tool_call_count": int(getattr(turn_log, "total_tool_calls", 0) or 0),
        "input_tokens": int(getattr(turn_log, "total_input_tokens", 0) or 0),
        "output_tokens": int(getattr(turn_log, "total_output_tokens", 0) or 0),
    }

    await update_agent_session(
        session_id,
        state_data_patch=state_patch,
        metrics_delta=metrics_delta,
        title_candidate=title_candidate,
    )

    if skip_emit_final or not message:
        return
    try:
        await emit_final_fn(
            session_id=session_id,
            response_route_id=response_route_id,
            content=message,
            emit_id=uuid4().hex,
        )
    except Exception as exc:
        logger.warning("[TurnHandler] final emit failed: %s", exc)


def _payload_from_job(job: Any) -> dict[str, Any]:
    payload = getattr(job, "payload", None)
    if isinstance(payload, dict):
        return dict(payload or {})
    return {
        "session_id": str(getattr(job, "session_id", "") or "").strip(),
        "response_route_id": str(getattr(job, "response_route_id", "") or "").strip(),
        "session_key": str(getattr(job, "session_key", "") or "").strip(),
        "source": dict(getattr(job, "source", {}) or {}),
        "user_text": str(getattr(job, "user_input", "") or "").strip(),
        "job_id": str(getattr(job, "job_id", "") or "").strip(),
        "job_kind": str(getattr(job, "job_kind", "turn") or "turn").strip() or "turn",
        "raw_data": dict(getattr(job, "raw_data", {}) or {}),
        "user_content_blocks": list(getattr(job, "user_content_blocks", []) or []),
    }


async def handle_unified_turn_job(
    job: Any,
    *,
    run_handle: Any = None,
    emit_final: FinalEmitter | None = None,
    emit_stream: StreamEmitter | None = None,
    emit_typing_indicator: TypingIndicatorEmitter | None = None,
) -> Any:
    payload = _payload_from_job(job)
    session_id = str(payload.get("session_id") or "").strip()
    response_route_id = str(payload.get("response_route_id") or "").strip()
    user_text = str(payload.get("user_text") or "").strip()
    original_user_text = user_text
    job_id = str(getattr(job, "job_id", "") or payload.get("job_id") or "").strip()
    job_kind = str(payload.get("job_kind") or "turn").strip() or "turn"
    raw_data = dict(payload.get("raw_data") or {})
    source = dict(payload.get("source") or {})
    user_content_blocks = list(payload.get("user_content_blocks") or [])

    if not session_id:
        raise RuntimeError("unified_agent.turn missing session_id")

    session = await load_agent_session(session_id)
    if not session:
        logger.warning("[TurnHandler] session not found: %s", session_id)
        return job_handled()

    emit_final_fn = emit_final or default_emit_final
    emit_stream_fn = emit_stream or default_emit_stream
    should_emit_typing_indicator = _should_emit_typing_indicator(
        session,
        job_kind=job_kind,
        raw_data=raw_data,
        response_route_id=response_route_id,
    )

    async def _emit_stream_frame(
        session_id: str,
        response_route_id: str,
        stream_type: str,
        state: str,
        seq: int,
        content: str,
        emit_id: str,
        *,
        thinking: str = "",
        redacted_thinking_count: int = 0,
        thinking_elapsed_ms: int = 0,
        tool_pending: bool = False,
        tool_elapsed_ms: int = 0,
        tool_steps: list[dict[str, Any]] | None = None,
    ) -> None:
        await emit_stream_fn(
            session_id=session_id,
            response_route_id=response_route_id,
            stream_type=stream_type,
            state=state,
            seq=seq,
            content=content,
            thinking=thinking,
            redacted_thinking_count=redacted_thinking_count,
            thinking_elapsed_ms=thinking_elapsed_ms,
            tool_pending=tool_pending,
            tool_elapsed_ms=tool_elapsed_ms,
            tool_steps=tool_steps,
            emit_id=emit_id,
        )

    final_answer_streamer = (
        FinalAnswerStreamer(
            session_id=session_id,
            response_route_id=response_route_id,
            emit_stream=_emit_stream_frame,
            min_interval_ms=150,
        )
        if _should_stream_final_answer(session) and response_route_id
        else None
    )

    async def _push_tool_start(tool_call: Any) -> None:
        if final_answer_streamer is None:
            return
        await final_answer_streamer.push_tool_start(
            tool_call_id=str(getattr(tool_call, "id", "") or "").strip(),
            tool_name=str(getattr(tool_call, "name", "") or "").strip(),
            arguments=dict(getattr(tool_call, "arguments", None) or {}),
        )

    async def _push_tool_finish(tool_call: Any, status: str, duration_ms: int) -> None:
        if final_answer_streamer is None:
            return
        await final_answer_streamer.push_tool_finish(
            tool_call_id=str(getattr(tool_call, "id", "") or "").strip(),
            tool_name=str(getattr(tool_call, "name", "") or "").strip(),
            arguments=dict(getattr(tool_call, "arguments", None) or {}),
            status=status,
            duration_ms=duration_ms,
        )

    async def cancellation_check() -> bool:
        if run_handle is not None and bool(getattr(run_handle, "cancelled", False)):
            return True
        return await _turn_cancel_requested(session_id, job_id)

    async def context_checkpoint(operation: str, payload: dict[str, Any]) -> None:
        op = str(operation or "").strip()
        checkpoint_payload = dict(payload or {})
        if op == _CHECKPOINT_APPEND_MESSAGE:
            await append_agent_session_message(
                session_id,
                dict(checkpoint_payload.get("message") or {}),
            )
            return
        if op == _CHECKPOINT_SNAPSHOT:
            state_data = checkpoint_payload.get("state_data")
            if isinstance(state_data, dict):
                await update_agent_session(session_id, state_data_patch=dict(state_data))
            return
        logger.warning("[TurnHandler] unknown context checkpoint operation: %s", op or "-")

    typing_indicator_started = False
    if should_emit_typing_indicator and emit_typing_indicator is not None:
        await _emit_typing_indicator_best_effort(
            emit_typing_indicator,
            session_id=session_id,
            response_route_id=response_route_id,
            operation="start",
        )
        typing_indicator_started = True

    try:
        if job_kind == "heartbeat":
            heartbeat_reason = str(raw_data.get("heartbeat_reason") or "").strip() or "exec-event"
            logger.info(
                "[ExecNotify] heartbeat start: owner_session_id=%s job_id=%s heartbeat_reason=%s",
                session_id,
                job_id,
                heartbeat_reason,
            )
            pending_events = _normalize_system_events(await pop_agent_session_pending_events(session_id))
            logger.info(
                "[ExecNotify] heartbeat popped events: owner_session_id=%s job_id=%s count=%s",
                session_id,
                job_id,
                len(pending_events),
            )
            if not pending_events:
                logger.info("[ExecNotify] heartbeat noop: owner_session_id=%s job_id=%s", session_id, job_id)
                await update_agent_session(session_id)
                return job_handled()
            formatted_events = _format_system_events(pending_events)
            heartbeat_prompt = (
                f"{formatted_events}\n\n"
                "System: 以上是后台任务完成事件。请只处理这些事件的结果，将执行状态简洁告知用户。"
                "不要主动读取聊天记录、群消息或调用与上述事件无关的工具。"
            ).strip()
            logger.info(
                "[ExecNotify] heartbeat prompt ready: owner_session_id=%s job_id=%s event_count=%s prompt_chars=%s",
                session_id,
                job_id,
                len(pending_events),
                len(heartbeat_prompt),
            )
            user_text = heartbeat_prompt
            user_content_blocks = []
            outcome = None
        else:
            system_events = _normalize_system_events(raw_data.get("system_events"))
            formatted_events = _format_system_events(system_events)
            if formatted_events:
                if user_content_blocks:
                    user_content_blocks = _prepend_system_events_to_blocks(
                        user_content_blocks,
                        system_events_text=formatted_events,
                    )
                else:
                    safe_user_text = _sanitize_system_prefixed_text(user_text)
                    user_text = f"{formatted_events}\n\n{safe_user_text}".strip() if safe_user_text else formatted_events
            outcome = None

        if outcome is None:
            try:
                if final_answer_streamer is not None:
                    await final_answer_streamer.start_tool_pending()
                outcome = await run_turn(
                    session=session,
                    user_text=user_text,
                    user_content_blocks=user_content_blocks,
                    on_progress=None,
                    on_final_stream_event=final_answer_streamer.push_event if final_answer_streamer is not None else None,
                    on_stream_cancel=final_answer_streamer.cancel if final_answer_streamer is not None else None,
                    on_tool_start=_push_tool_start if final_answer_streamer is not None else None,
                    on_tool_finish=_push_tool_finish if final_answer_streamer is not None else None,
                    cancellation_check=cancellation_check,
                    cancel_event=getattr(run_handle, "cancel_event", None),
                    thread_cancel_event=getattr(run_handle, "thread_cancel_event", None),
                    provider_cancel_registrar=getattr(run_handle, "set_provider_cancel_handle", None),
                    tool_run_registrar=getattr(run_handle, "register_tool_run", None),
                    tool_run_finisher=getattr(run_handle, "finish_tool_run", None),
                    context_checkpoint=context_checkpoint,
                    run_id=job_id,
                    response_route_id=response_route_id,
                )
                if job_kind == "heartbeat":
                    logger.info(
                        "[ExecNotify] heartbeat turn done: owner_session_id=%s job_id=%s status=%s reply_chars=%s",
                        session_id,
                        job_id,
                        outcome.status,
                        len(str(outcome.reply or "")),
                    )
            except Exception as exc:
                logger.error("[TurnHandler] turn failed: %s", exc, exc_info=True)
                if job_kind == "heartbeat":
                    logger.error(
                        "[ExecNotify] heartbeat turn failed: owner_session_id=%s job_id=%s error=%s",
                        session_id,
                        job_id,
                        exc,
                        exc_info=True,
                    )
                outcome = TurnOutcome(
                    status="error",
                    reply=f"执行失败: {exc}",
                    state_data_patch=dict(getattr(session, "state_data", {}) or {}),
                )

        stream_final_delivered = False
        if final_answer_streamer is not None:
            try:
                if outcome.status == "cancelled":
                    await final_answer_streamer.cancel()
                elif outcome.status == "error":
                    await final_answer_streamer.fail(outcome.reply or "执行失败。")
                else:
                    await final_answer_streamer.finish(outcome.reply or "Done.")
                stream_final_delivered = final_answer_streamer.delivered_any
            except Exception as exc:
                logger.warning("[TurnHandler] final answer stream emit failed: %s", exc, exc_info=True)

        latest_session = await load_agent_session(session_id)
        if latest_session is None:
            logger.info("[TurnHandler] session disappeared before persist: session_id=%s", session_id)
            return job_handled()

        if job_kind == "heartbeat":
            logger.info(
                "[ExecNotify] heartbeat deliver: owner_session_id=%s job_id=%s status=%s skip_emit_final=%s",
                session_id,
                job_id,
                outcome.status,
                bool(stream_final_delivered or outcome.status == "cancelled"),
            )
            if not str(outcome.reply or "").strip():
                logger.warning(
                    "[ExecNotify] heartbeat produced no user-visible reply: owner_session_id=%s job_id=%s status=%s",
                    session_id,
                    job_id,
                    outcome.status,
                )

        await _persist_and_deliver(
            latest_session,
            outcome,
            response_route_id=response_route_id,
            emit_final_fn=emit_final_fn,
            skip_emit_final=stream_final_delivered or outcome.status == "cancelled",
            title_candidate=original_user_text if job_kind != "heartbeat" else "",
        )
        return job_handled()
    finally:
        if typing_indicator_started:
            await _emit_typing_indicator_best_effort(
                emit_typing_indicator,
                session_id=session_id,
                response_route_id=response_route_id,
                operation="stop",
            )


__all__ = ["handle_unified_turn_job"]
