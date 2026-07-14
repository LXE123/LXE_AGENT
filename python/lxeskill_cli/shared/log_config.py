from __future__ import annotations

from shared.env_config import env_flag


def local_logs_enabled() -> bool:
    return env_flag("LOCAL_LOGS_ENABLED", False)


__all__ = ["local_logs_enabled"]
