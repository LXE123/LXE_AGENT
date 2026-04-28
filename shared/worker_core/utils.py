from __future__ import annotations

import os

from shared.logging import logger


async def emit_tool_files_to_session(session_id: str, files: list[str]) -> bool:
    # 延迟导入避免循环依赖
    from agent_runtime.ipc_client import emit_tool
    
    file_paths = [
        os.path.abspath(str(path or "").strip())
        for path in list(files or [])
        if str(path or "").strip()
    ]
    if not session_id or not file_paths or not all(os.path.exists(path) for path in file_paths):
        return False

    try:
        await emit_tool(
            session_id=str(session_id or "").strip(),
            files=file_paths,
        )
        logger.info("[Worker] session_id=%s | sent_files=%s", session_id, [os.path.basename(path) for path in file_paths])
        return True
    except Exception as error:
        logger.error(
            "[Worker] session_id=%s | file_send_failed=%s | error=%s",
            session_id,
            file_paths,
            error,
            exc_info=True,
        )
        return False


async def send_file_to_current_session(session_id: str, path: str) -> bool:
    normalized_path = str(path or "").strip()
    if not normalized_path:
        return False
    return await emit_tool_files_to_session(str(session_id or "").strip(), [normalized_path])
