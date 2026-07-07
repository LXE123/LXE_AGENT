from __future__ import annotations

import socket
import time
from typing import Any

from shared.agent_state import MESSAGES_KEY, context_state
from shared.db.shared_state_dto import AgentSessionState
from shared.db.sqlite.agent_sessions import list_agent_sessions
from shared.db.sqlite.usage_stats import export_turn_usage

from .identity import load_or_create_machine_id


def _messages_from_state(state: AgentSessionState) -> list[dict[str, Any]]:
    messages = context_state(state.state_data).get(MESSAGES_KEY) or []
    return [dict(message) for message in list(messages or []) if isinstance(message, dict)]


def _session_payload(state: AgentSessionState) -> dict[str, Any]:
    messages = _messages_from_state(state)
    return {
        "session_id": str(state.session_id or ""),
        "source": dict(state.source or {}),
        "model": str(state.model or ""),
        "model_config": dict(state.model_config or {}),
        "created_at": float(state.created_at or 0),
        "last_active_at": float(state.last_active_at or 0),
        "message_count": int(state.message_count or len(messages)),
        "api_call_count": int(state.api_call_count or 0),
        "tool_call_count": int(state.tool_call_count or 0),
        "input_tokens": int(state.input_tokens or 0),
        "output_tokens": int(state.output_tokens or 0),
        "title": str(state.title or ""),
        "messages": messages,
    }


def _turn_usage_payload(days: int) -> dict[str, Any]:
    safe_days = max(1, int(days or 0) or 30)
    try:
        turns = export_turn_usage(days=safe_days)
    except Exception:
        turns = []
    return {"days": safe_days, "turns": turns}


def build_agent_snapshot(
    *,
    gateway_id: str = "",
    machine_id: str | None = None,
    session_limit: int = 1000,
    usage_days: int = 30,
) -> dict[str, Any]:
    resolved_machine_id = str(machine_id or load_or_create_machine_id()).strip()
    sessions = list_agent_sessions(limit=session_limit)
    return {
        "machine_id": resolved_machine_id,
        "gateway_id": str(gateway_id or "").strip(),
        "hostname": socket.gethostname(),
        "uploaded_at": time.time(),
        "sessions": [_session_payload(session) for session in sessions],
        "turn_usage": _turn_usage_payload(usage_days),
    }


__all__ = ["build_agent_snapshot"]
