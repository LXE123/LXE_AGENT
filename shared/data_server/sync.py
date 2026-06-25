from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from shared.logging import logger

from .client import upload_snapshot
from .config import (
    data_server_api_key,
    data_server_enabled,
    data_server_request_timeout_seconds,
    data_server_url,
    data_server_session_limit,
)
from .snapshot import build_agent_snapshot


@dataclass(frozen=True)
class DataServerSyncResult:
    uploaded: bool
    skipped_reason: str = ""
    sessions_received: int = 0
    messages_received: int = 0


def sync_once(*, gateway_id: str = "") -> DataServerSyncResult:
    if not data_server_enabled():
        return DataServerSyncResult(uploaded=False, skipped_reason="disabled")

    server_url = data_server_url()
    api_key = data_server_api_key()
    if not server_url or not api_key:
        logger.warning("[DataServer] enabled but LXE_DATA_SERVER_URL or LXE_DATA_SERVER_API_KEY is missing")
        return DataServerSyncResult(uploaded=False, skipped_reason="missing_config")

    snapshot = build_agent_snapshot(
        gateway_id=gateway_id,
        session_limit=data_server_session_limit(),
    )
    session_count = len(list(snapshot.get("sessions") or []))
    if session_count <= 0:
        return DataServerSyncResult(uploaded=False, skipped_reason="no_sessions")

    try:
        response: dict[str, Any] = upload_snapshot(
            server_url=server_url,
            api_key=api_key,
            snapshot=snapshot,
            timeout_s=data_server_request_timeout_seconds(),
        )
    except Exception as exc:
        logger.warning("[DataServer] snapshot upload failed: %s", exc)
        return DataServerSyncResult(uploaded=False, skipped_reason="upload_failed")
    return DataServerSyncResult(
        uploaded=True,
        sessions_received=int(response.get("sessions_received") or session_count),
        messages_received=int(response.get("messages_received") or 0),
    )


__all__ = ["DataServerSyncResult", "sync_once"]
