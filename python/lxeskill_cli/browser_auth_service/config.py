from __future__ import annotations

from shared.env_config import env_flag, env_int

BROWSER_AUTH_HEADLESS = env_flag("BROWSER_AUTH_HEADLESS", True)
BROWSER_AUTH_LOCK_TIMEOUT_SECONDS = env_int("BROWSER_AUTH_LOCK_TIMEOUT_SECONDS", 180, minimum=1)


__all__ = [
    "BROWSER_AUTH_HEADLESS",
    "BROWSER_AUTH_LOCK_TIMEOUT_SECONDS",
]
