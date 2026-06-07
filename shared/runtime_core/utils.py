from __future__ import annotations

import os

from shared.logging import logger


async def emit_tool_files_to_session(
    session_id: str,
    files: list[str],
    *,
    response_route_id: str = "",
) -> None:
    from agent_runtime.emit_bus import emit_tool

    safe_session_id = str(session_id or "").strip()
    file_paths = [
        os.path.abspath(str(path or "").strip())
        for path in list(files or [])
        if str(path or "").strip()
    ]
    if not safe_session_id:
        raise RuntimeError("session_id is required for file send")
    if not file_paths:
        raise RuntimeError("file path is required for file send")
    missing = [path for path in file_paths if not os.path.exists(path)]
    if missing:
        raise RuntimeError(f"file path missing: {missing}")

    await emit_tool(
        session_id=safe_session_id,
        response_route_id=str(response_route_id or "").strip(),
        files=file_paths,
    )
    logger.info(
        "[Runtime] session_id=%s response_route_id=%s | sent_files=%s",
        safe_session_id,
        str(response_route_id or "").strip(),
        [os.path.basename(path) for path in file_paths],
    )


async def send_file_to_current_session(
    session_id: str,
    path: str,
    *,
    response_route_id: str = "",
) -> None:
    normalized_path = str(path or "").strip()
    if not normalized_path:
        raise RuntimeError("file path is required for file send")
    await emit_tool_files_to_session(
        str(session_id or "").strip(),
        [normalized_path],
        response_route_id=response_route_id,
    )


__all__ = [
    "emit_tool_files_to_session",
    "send_file_to_current_session",
]
