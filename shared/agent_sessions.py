from __future__ import annotations


class AgentSessionStatus:
    STARTING = "starting"
    RUNNING = "running"
    WAITING_USER_INPUT = "waiting_user_input"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


ACTIVE_AGENT_SESSION_STATUSES = {
    AgentSessionStatus.STARTING,
    AgentSessionStatus.RUNNING,
    AgentSessionStatus.WAITING_USER_INPUT,
}

TERMINAL_AGENT_SESSION_STATUSES = {
    AgentSessionStatus.COMPLETED,
    AgentSessionStatus.FAILED,
    AgentSessionStatus.CANCELLED,
}


def is_active_agent_session_status(status: str) -> bool:
    return str(status or "").strip() in ACTIVE_AGENT_SESSION_STATUSES


def is_terminal_agent_session_status(status: str) -> bool:
    return str(status or "").strip() in TERMINAL_AGENT_SESSION_STATUSES
