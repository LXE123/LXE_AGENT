"""Agent execution handlers for the root gateway runtime."""
from __future__ import annotations

import time
from typing import Any
from uuid import uuid4

from agent_runtime.ipc_client import emit_final, emit_stream
from shared.agent_state import RUNTIME_KEY, runtime_state
from shared.agent_sessions import AgentSessionStatus
from shared.db.client import (
    load_agent_session,
    pop_agent_session_pending_events,
    update_agent_session,
)
from shared.logging import logger
from shared.worker_core.outcome import job_handled

from .final_answer_streamer import FinalAnswerStreamer
from .runtime import run_turn
from .types import TurnOutcome


_STATUS_MAP: dict[str, str] = {
    "done": AgentSessionStatus.WAITING_USER_INPUT,
    "waiting": AgentSessionStatus.WAITING_USER_INPUT,
    "cancelled": AgentSessionStatus.WAITING_USER_INPUT,
    "error": AgentSessionStatus.WAITING_USER_INPUT,
}


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
    return str(getattr(session, "platform", "") or "").strip() == "feishu"


async def _turn_cancel_requested(session_id: str, job_id: str) -> bool:
    safe_session_id = str(session_id or "").strip()
    safe_job_id = str(job_id or "").strip()
    if not safe_session_id or not safe_job_id:
        return False

    latest = await load_agent_session(safe_session_id)
    if not latest:
        return True

    latest_status = str(getattr(latest, "status", "") or "").strip()
    if latest_status in {AgentSessionStatus.CANCELLED, AgentSessionStatus.FAILED}:
        return True

    latest_runtime = runtime_state(getattr(latest, "state_data", {}) or {})
    return str(latest_runtime.get("stop_turn_id") or "").strip() == safe_job_id


def _finalize_runtime_patch(outcome: TurnOutcome, *, latest_session: Any, job_id: str) -> dict[str, Any]:
    latest_runtime = runtime_state(getattr(latest_session, "state_data", {}) or {})
    runtime_updates = {
        "active_turn_id": "",
        "active_turn_started_at": 0,
    }
    if str(latest_runtime.get("stop_turn_id") or "").strip() == str(job_id or "").strip():
        runtime_updates.update(
            {
                "stop_turn_id": "",
                "stop_requested_at": 0,
            }
        )
    patch = dict(outcome.state_data_patch or {})
    patch_runtime = dict(patch.get(RUNTIME_KEY) or {}) if isinstance(patch.get(RUNTIME_KEY), dict) else {}
    patch_runtime.update(runtime_updates)
    patch[RUNTIME_KEY] = patch_runtime
    return patch


async def _emit_final_answer_stream_frame(
    session_id: str,
    stream_type: str,
    state: str,
    seq: int,
    content: str,
    emit_id: str,
) -> None:
    await emit_stream(
        session_id=session_id,
        stream_type=stream_type,
        state=state,
        seq=seq,
        content=content,
        emit_id=emit_id,
    )


async def _persist_and_deliver(
    session: Any,
    outcome: TurnOutcome,
    *,
    skip_emit_final: bool = False,
) -> None:
    session_id = str(getattr(session, "session_id", "") or "").strip()

    session_status = _STATUS_MAP.get(
        outcome.status,
        AgentSessionStatus.WAITING_USER_INPUT,
    )
    message = str(outcome.reply or "").strip()
    state_patch = dict(outcome.state_data_patch or {})

    await update_agent_session(
        session_id,
        status=session_status,
        state_data_patch=state_patch,
    )

    if skip_emit_final or not message:
        return
    try:
        await emit_final(
            session_id=session_id,
            content=message,
            emit_id=uuid4().hex,
        )
    except Exception as exc:
        logger.warning("[UnifiedWorker] final emit failed: %s", exc)


async def handle_unified_turn_job(job: Any) -> Any:
    payload = dict(getattr(job, "payload", {}) or {})
    session_id = str(payload.get("session_id") or "").strip()
    user_text = str(payload.get("user_text") or "").strip()
    job_id = str(getattr(job, "job_id", "") or payload.get("job_id") or "").strip()
    job_kind = str(payload.get("job_kind") or "turn").strip() or "turn"
    raw_data = dict(payload.get("raw_data") or {})
    user_content_blocks = list(payload.get("user_content_blocks") or [])

    if not session_id:
        raise RuntimeError("unified_agent.turn missing session_id")

    session = await load_agent_session(session_id)
    if not session:
        logger.warning("[UnifiedWorker] session not found: %s", session_id)
        return job_handled()

    allowed_statuses = {
        AgentSessionStatus.STARTING,
        AgentSessionStatus.RUNNING,
    }
    if job_kind == "heartbeat":
        allowed_statuses.add(AgentSessionStatus.WAITING_USER_INPUT)
    if str(session.status or "").strip() not in allowed_statuses:
        logger.info(
            "[UnifiedWorker] skip stale turn job: session_id=%s status=%s job_kind=%s",
            session_id,
            session.status,
            job_kind,
        )
        return job_handled()

    final_answer_streamer = (
        FinalAnswerStreamer(
            session_id=session_id,
            emit_stream=_emit_final_answer_stream_frame,
            min_interval_ms=150,
        )
        if _should_stream_final_answer(session)
        else None
    )

    async def cancellation_check() -> bool:
        return await _turn_cancel_requested(session_id, job_id)

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
            await update_agent_session(
                session_id,
                status=AgentSessionStatus.WAITING_USER_INPUT,
                state_data_patch={
                    RUNTIME_KEY: {
                        "active_turn_id": "",
                        "active_turn_started_at": 0,
                    },
                },
            )
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
            outcome = await run_turn(
                session=session,
                user_text=user_text,
                user_content_blocks=user_content_blocks,
                on_progress=None,
                on_final_text_delta=final_answer_streamer.push_delta if final_answer_streamer is not None else None,
                on_stream_cancel=final_answer_streamer.cancel if final_answer_streamer is not None else None,
                cancellation_check=cancellation_check,
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
            logger.error("[UnifiedWorker] turn failed: %s", exc, exc_info=True)
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
            logger.warning("[UnifiedWorker] final answer stream emit failed: %s", exc, exc_info=True)

    latest_session = await load_agent_session(session_id)
    if latest_session is None:
        logger.info("[UnifiedWorker] session disappeared before persist: session_id=%s", session_id)
        return job_handled()

    outcome.state_data_patch = _finalize_runtime_patch(
        outcome,
        latest_session=latest_session,
        job_id=job_id,
    )

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
        skip_emit_final=stream_final_delivered or outcome.status == "cancelled",
    )
    return job_handled()


__all__ = ["handle_unified_turn_job"]
