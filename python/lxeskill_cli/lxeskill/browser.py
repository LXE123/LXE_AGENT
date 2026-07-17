from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from lxeskill.business import allowed_output_file
from shared.logging import get_logger


logger = get_logger(__name__)


class BrowserCliError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


async def execute_browser_command(
    entry: dict[str, Any],
    arguments: dict[str, Any],
    session_id: str,
) -> tuple[dict[str, Any], list[str]]:
    safe_session_id = str(session_id or "").strip()
    if not safe_session_id:
        raise BrowserCliError("session_required", "browser command requires LXE_AGENT_SESSION_ID")
    from services.browser.tools import client as browser_client

    session = SimpleNamespace(session_id=safe_session_id)
    result = await browser_client.execute_browser_tool(
        str(entry.get("name") or ""),
        arguments,
        session,
    )
    if not result.success:
        raise BrowserCliError(
            str(result.error_code or "browser_tool_failed"),
            str(result.error_message or "browser command failed"),
        )
    content = [dict(item or {}) for item in list(result.content or [])]
    owners = [str(item) for item in list(entry.get("owner_skills") or [])]
    validated_files = [
        str(allowed_output_file(str(path), owner_skills=owners))
        for path in list(result.files or [])
    ]
    action = str(arguments.get("action") or "").strip().lower()
    if str(entry.get("name") or "") == "ziniao_page" and action == "browser_vision":
        if len(validated_files) != 1:
            raise BrowserCliError("browser_screenshot_missing", "browser_vision did not return one screenshot")
        return {"content": content, "screenshot_path": validated_files[0]}, []
    return {"content": content}, validated_files


__all__ = ["BrowserCliError", "execute_browser_command"]
