from __future__ import annotations

import socket

from shared.env_config import env_flag, env_int, env_text


GATEWAY_ID = env_text("GATEWAY_ID", f"{socket.gethostname()}-agent")
GATEWAY_ADAPTER_RECYCLE_ENABLED = env_flag("GATEWAY_ADAPTER_RECYCLE_ENABLED", True)
GATEWAY_ADAPTER_WATCHDOG_ENABLED = env_flag("GATEWAY_ADAPTER_WATCHDOG_ENABLED", True)
AGENT_MAX_CONCURRENCY = env_int("AGENT_MAX_CONCURRENCY", 2, minimum=1)


__all__ = [
    "AGENT_MAX_CONCURRENCY",
    "GATEWAY_ADAPTER_RECYCLE_ENABLED",
    "GATEWAY_ADAPTER_WATCHDOG_ENABLED",
    "GATEWAY_ID",
]
