from __future__ import annotations

from shared.env_config import env_flag, env_int, env_text


def telemetry_enabled() -> bool:
    return env_flag("TELEMETRY_ENABLED", False)


def telemetry_server_url() -> str:
    return env_text("TELEMETRY_SERVER_URL", "")


def telemetry_api_key() -> str:
    return env_text("TELEMETRY_API_KEY", "")


def telemetry_sync_interval_seconds() -> int:
    return env_int("TELEMETRY_SYNC_INTERVAL_SECONDS", 300, minimum=30)


def telemetry_request_timeout_seconds() -> int:
    return env_int("TELEMETRY_REQUEST_TIMEOUT_SECONDS", 30, minimum=1)


def telemetry_session_limit() -> int:
    return env_int("TELEMETRY_SESSION_LIMIT", 1000, minimum=1)


__all__ = [
    "telemetry_api_key",
    "telemetry_enabled",
    "telemetry_request_timeout_seconds",
    "telemetry_server_url",
    "telemetry_session_limit",
    "telemetry_sync_interval_seconds",
]
