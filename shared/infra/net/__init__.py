from __future__ import annotations

from .aiohttp_client import (
    HttpSessionPurpose,
    close_all_aiohttp_sessions,
    dingtalk_http_session,
    erp_http_session,
    external_http_session,
    get_aiohttp_session,
)
from .policy import (
    bootstrap_network_policy,
    build_child_env,
    log_network_snapshot,
    network_snapshot,
)
from .requests_client import (
    RequestsPurpose,
    close_all_requests_sessions,
    dingtalk_requests_session,
    external_requests_session,
    get_requests_session,
    llm_requests_session,
    local_service_requests_session,
    ocr_requests_session,
)
from .websocket_client import connect_websocket, websocket_connect_defaults


async def close_all_network_clients() -> None:
    await close_all_aiohttp_sessions()
    close_all_requests_sessions()


__all__ = [
    "HttpSessionPurpose",
    "RequestsPurpose",
    "bootstrap_network_policy",
    "build_child_env",
    "close_all_aiohttp_sessions",
    "close_all_network_clients",
    "close_all_requests_sessions",
    "connect_websocket",
    "dingtalk_http_session",
    "dingtalk_requests_session",
    "erp_http_session",
    "external_http_session",
    "external_requests_session",
    "get_aiohttp_session",
    "get_requests_session",
    "llm_requests_session",
    "local_service_requests_session",
    "log_network_snapshot",
    "network_snapshot",
    "ocr_requests_session",
    "websocket_connect_defaults",
]
