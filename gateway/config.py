from __future__ import annotations

import socket

from shared.env_config import env_int, env_text


GATEWAY_ID = env_text("GATEWAY_ID", f"{socket.gethostname()}-agent")
AGENT_MAX_CONCURRENCY = env_int("AGENT_MAX_CONCURRENCY", 2, minimum=1)


__all__ = [
    "AGENT_MAX_CONCURRENCY",
    "GATEWAY_ID",
]
