from __future__ import annotations

import json
import time
from hashlib import sha256
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from py_tools.business import allowed_output_file
from shared.agent_state import merge_agent_state
from shared.db.sqlite.engine import connection_scope
from shared.logging import get_logger
from shared.process_lock import InterProcessLockTimeout, interprocess_lock
from services.browser.store.agent_tool_state import load_tool_state


logger = get_logger(__name__)
PROJECT_ROOT = Path(__file__).resolve().parents[1]


class BrowserCliError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def _session_lock_path(session_id: str) -> Path:
    digest = sha256(session_id.encode("utf-8")).hexdigest()[:24]
    return PROJECT_ROOT / "tmp" / "lxeskill" / f"session-{digest}.lock"


def _patch_session_state(session_id: str, patch: dict[str, Any]) -> None:
    with connection_scope() as conn:
        row = conn.execute("SELECT source FROM agent_sessions WHERE session_id = ?", (session_id,)).fetchone()
        if row is None:
            raise BrowserCliError("session_not_found", f"agent session not found: {session_id}")
        try:
            source = json.loads(str(row["source"] or "{}"))
        except (TypeError, ValueError, json.JSONDecodeError) as exc:
            raise BrowserCliError("session_state_invalid", f"agent session source is invalid: {session_id}") from exc
        source["tool_state"] = merge_agent_state(dict(source.get("tool_state") or {}), patch)
        conn.execute(
            "UPDATE agent_sessions SET source = ?, last_active_at = ? WHERE session_id = ?",
            (json.dumps(source, ensure_ascii=False, separators=(",", ":")), time.time(), session_id),
        )


async def execute_browser_command(
    entry: dict[str, Any],
    arguments: dict[str, Any],
    session_id: str,
) -> tuple[dict[str, Any], list[str]]:
    safe_session_id = str(session_id or "").strip()
    if not safe_session_id:
        raise BrowserCliError("session_required", "browser command requires LXE_AGENT_SESSION_ID")
    try:
        with interprocess_lock(_session_lock_path(safe_session_id), timeout_seconds=180):
            state_data = load_tool_state(safe_session_id)
            if state_data is None:
                raise BrowserCliError("session_not_found", f"agent session not found: {safe_session_id}")
            from services.browser.tools import client as browser_client

            session = SimpleNamespace(session_id=safe_session_id, source={}, state_data=state_data)
            result = await browser_client.execute_browser_tool(
                str(entry.get("name") or ""),
                arguments,
                session,
            )
            if result.state_patch:
                _patch_session_state(safe_session_id, dict(result.state_patch))
            if not result.success:
                raise BrowserCliError(
                    str(result.error_code or "browser_tool_failed"),
                    str(result.error_message or "browser command failed"),
                )
            content = [dict(item or {}) for item in list(result.content or [])]
            files = [str(allowed_output_file(str(path))) for path in list(result.files or [])]
            return {"content": content}, files
    except InterProcessLockTimeout as exc:
        raise BrowserCliError("session_busy", str(exc)) from exc


__all__ = ["BrowserCliError", "execute_browser_command"]
