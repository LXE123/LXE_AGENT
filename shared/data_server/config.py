from __future__ import annotations

from shared.env_config import env_flag, env_int, env_text


def data_server_enabled() -> bool:
    return env_flag("LXE_DATA_SERVER_ENABLED", False)


def data_server_url() -> str:
    return env_text("LXE_DATA_SERVER_URL", "")


def data_server_api_key() -> str:
    return env_text("LXE_DATA_SERVER_API_KEY", "")


def data_server_sync_interval_seconds() -> int:
    return env_int("LXE_DATA_SERVER_SYNC_INTERVAL_SECONDS", 10800, minimum=30)


def data_server_request_timeout_seconds() -> int:
    return env_int("LXE_DATA_SERVER_REQUEST_TIMEOUT_SECONDS", 30, minimum=1)


def data_server_session_limit() -> int:
    return env_int("LXE_DATA_SERVER_SESSION_LIMIT", 1000, minimum=1)


__all__ = [
    "data_server_api_key",
    "data_server_enabled",
    "data_server_request_timeout_seconds",
    "data_server_url",
    "data_server_session_limit",
    "data_server_sync_interval_seconds",
]
