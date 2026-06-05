from __future__ import annotations

import os


def _env_flag(name: str, default: bool) -> bool:
    raw = str(os.getenv(name, "1" if default else "0")).strip().lower()
    return raw not in {"0", "false", "no", "off", ""}


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except Exception:
        return int(default)


def dashboard_enabled() -> bool:
    return _env_flag("AGENT_DASHBOARD_ENABLED", True)


def dashboard_host() -> str:
    return str(os.getenv("AGENT_DASHBOARD_HOST", "127.0.0.1") or "127.0.0.1").strip()


def dashboard_port() -> int:
    return _env_int("AGENT_DASHBOARD_PORT", 8765)


__all__ = ["dashboard_enabled", "dashboard_host", "dashboard_port"]
