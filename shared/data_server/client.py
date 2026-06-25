from __future__ import annotations

from typing import Any

from shared.infra.net import local_service_requests_session


def upload_snapshot(
    *,
    server_url: str,
    api_key: str,
    snapshot: dict[str, Any],
    timeout_s: float = 30,
) -> dict[str, Any]:
    base_url = str(server_url or "").strip().rstrip("/")
    if not base_url:
        raise RuntimeError("data server URL is required")
    if not str(api_key or "").strip():
        raise RuntimeError("data server API key is required")

    response = local_service_requests_session.post(
        f"{base_url}/api/v1/agent-data/snapshots",
        headers={"Authorization": f"Bearer {api_key}"},
        json=snapshot,
        timeout=float(timeout_s),
    )
    response.raise_for_status()
    payload = response.json()
    return dict(payload or {}) if isinstance(payload, dict) else {}


__all__ = ["upload_snapshot"]
