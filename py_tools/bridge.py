from __future__ import annotations

import asyncio
import contextlib
import json
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from shared.logging import get_logger


logger = get_logger(__name__)
_PROTOCOL_VERSION = "1"
_ALLOWED_TOOLS = {"ziniao_browser", "ziniao_page"}


def _response(call_id: str, *, ok: bool, content: list[dict[str, Any]] | None = None,
              state_patch: dict[str, Any] | None = None, files: list[str] | None = None,
              error: dict[str, str] | None = None) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "protocol_version": _PROTOCOL_VERSION,
        "call_id": call_id,
        "ok": ok,
        "content": list(content or []),
    }
    if state_patch:
        payload["state_patch"] = dict(state_patch)
    if files:
        payload["files"] = list(files)
    if error:
        payload["error"] = dict(error)
    return payload


def _files_from_content(content: list[dict[str, Any]]) -> list[str]:
    files: list[str] = []
    for block in content:
        if str(block.get("type") or "") != "text":
            continue
        text = str(block.get("text") or "").strip()
        if text.startswith("MEDIA:"):
            path = str(Path(text.removeprefix("MEDIA:").strip()).resolve())
            if path not in files:
                files.append(path)
    return files


async def _execute(request: dict[str, Any]) -> dict[str, Any]:
    call_id = str(request.get("call_id") or "").strip()
    if str(request.get("protocol_version") or "") != _PROTOCOL_VERSION:
        return _response(call_id, ok=False, error={"code": "invalid_protocol", "message": "protocol_version must be 1"})
    tool_name = str(request.get("tool_name") or "").strip()
    if tool_name == "browser_auth_refresh":
        from clients.auth.browser_auth_client import ensure_auth

        arguments = dict(request.get("arguments") or {})
        payload = await ensure_auth(
            scope=str(arguments.get("scope") or "erp").strip() or "erp",
            account=str(arguments.get("account") or "").strip(),
            require_wms_cookie_header=bool(arguments.get("require_wms_cookie_header")),
            force_refresh=bool(arguments.get("force_refresh")),
        )
        return _response(call_id, ok=True, content=[{
            "type": "text",
            "text": json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        }])
    if tool_name not in _ALLOWED_TOOLS:
        return _response(call_id, ok=False, error={"code": "unknown_tool", "message": f"unsupported Python tool: {tool_name}"})

    from agent_runtime.packs.browser.tools import browser_tool_names
    from agent_runtime.tool_executor import ToolExecutionContext, clear_tool_context, make_browser_tool_handler, set_tool_context
    from services.browser.store.ziniao_config import ziniao_tool_config_status

    configured, reason = ziniao_tool_config_status()
    if not configured:
        return _response(call_id, ok=False, error={"code": "not_configured", "message": reason})
    if tool_name not in browser_tool_names():
        return _response(call_id, ok=False, error={"code": "unknown_tool", "message": f"unknown browser tool: {tool_name}"})

    session_data = dict(request.get("session") or {})
    session = SimpleNamespace(
        session_id=str(session_data.get("session_id") or ""),
        source={},
        state_data={},
    )
    context = ToolExecutionContext(
        session=session,
        state_data={},
        turn_id=call_id,
        response_route_id=str(session_data.get("response_route_id") or ""),
    )
    set_tool_context(context)
    try:
        result = await make_browser_tool_handler(tool_name)(**dict(request.get("arguments") or {}))
    finally:
        clear_tool_context()
    content = [dict(item or {}) for item in list(result.content or [])]
    return _response(
        call_id,
        ok=True,
        content=content,
        state_patch=dict(context.state_data or {}),
        files=_files_from_content(content),
    )


def main() -> int:
    original_stdout = sys.stdout
    try:
        raw = sys.stdin.readline()
        if not raw:
            payload = _response("", ok=False, error={"code": "empty_request", "message": "request JSON is required"})
        else:
            request = json.loads(raw)
            if not isinstance(request, dict):
                raise ValueError("request must be a JSON object")
            with contextlib.redirect_stdout(sys.stderr):
                payload = asyncio.run(_execute(request))
    except Exception as exc:
        logger.exception("Python tool bridge failed")
        call_id = str(locals().get("request", {}).get("call_id") or "") if isinstance(locals().get("request"), dict) else ""
        payload = _response(call_id, ok=False, error={"code": type(exc).__name__, "message": str(exc)})
    original_stdout.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
    original_stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
