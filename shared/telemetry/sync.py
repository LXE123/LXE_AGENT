from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from shared.logging import logger

from .client import upload_snapshot
from .config import (
    telemetry_api_key,
    telemetry_enabled,
    telemetry_request_timeout_seconds,
    telemetry_server_url,
    telemetry_session_limit,
)
from .snapshot import build_telemetry_snapshot


@dataclass(frozen=True)
class TelemetrySyncResult:
    uploaded: bool
    skipped_reason: str = ""
    sessions_received: int = 0
    messages_received: int = 0


def sync_once(*, gateway_id: str = "") -> TelemetrySyncResult:
    if not telemetry_enabled():
        return TelemetrySyncResult(uploaded=False, skipped_reason="disabled")

    server_url = telemetry_server_url()
    api_key = telemetry_api_key()
    if not server_url or not api_key:
        logger.warning("[Telemetry] enabled but TELEMETRY_SERVER_URL or TELEMETRY_API_KEY is missing")
        return TelemetrySyncResult(uploaded=False, skipped_reason="missing_config")

    snapshot = build_telemetry_snapshot(
        gateway_id=gateway_id,
        session_limit=telemetry_session_limit(),
    )
    session_count = len(list(snapshot.get("sessions") or []))
    if session_count <= 0:
        return TelemetrySyncResult(uploaded=False, skipped_reason="no_sessions")

    try:
        response: dict[str, Any] = upload_snapshot(
            server_url=server_url,
            api_key=api_key,
            snapshot=snapshot,
            timeout_s=telemetry_request_timeout_seconds(),
        )
    except Exception as exc:
        logger.warning("[Telemetry] snapshot upload failed: %s", exc)
        return TelemetrySyncResult(uploaded=False, skipped_reason="upload_failed")
    return TelemetrySyncResult(
        uploaded=True,
        sessions_received=int(response.get("sessions_received") or session_count),
        messages_received=int(response.get("messages_received") or 0),
    )


__all__ = ["TelemetrySyncResult", "sync_once"]
