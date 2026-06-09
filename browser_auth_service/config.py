from __future__ import annotations

from shared.env_config import env_flag

BROWSER_AUTH_HEADLESS = env_flag("BROWSER_AUTH_HEADLESS", True)
FBA_LOGISTICS_TOKEN_HEADLESS = env_flag("FBA_LOGISTICS_TOKEN_HEADLESS", BROWSER_AUTH_HEADLESS)


__all__ = [
    "BROWSER_AUTH_HEADLESS",
    "FBA_LOGISTICS_TOKEN_HEADLESS",
]
