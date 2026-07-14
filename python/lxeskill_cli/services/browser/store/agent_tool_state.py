from __future__ import annotations

import json
from typing import Any

from shared.db.sqlite.engine import connection_scope
from shared.logging import get_logger


logger = get_logger(__name__)


def load_tool_state(session_id: str) -> dict[str, Any] | None:
    """Load the persisted one-shot tool state without recreating a runtime object."""
    safe_session_id = str(session_id or "").strip()
    if not safe_session_id:
        return None
    with connection_scope() as conn:
        row = conn.execute(
            "SELECT source FROM agent_sessions WHERE session_id = ?",
            (safe_session_id,),
        ).fetchone()
    if row is None:
        return None
    try:
        source = json.loads(str(row["source"] or "{}"))
    except (TypeError, ValueError, json.JSONDecodeError):
        logger.warning("Invalid agent session source JSON", extra={"session_id": safe_session_id})
        return {}
    tool_state = source.get("tool_state") if isinstance(source, dict) else None
    return dict(tool_state) if isinstance(tool_state, dict) else {}


__all__ = ["load_tool_state"]
