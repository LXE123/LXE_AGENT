from __future__ import annotations

import platform
from pathlib import Path

from shared.env_config import env_int, env_path, env_text


ZINIAO_CLIENT_PATH = env_path("ZINIAO_CLIENT_PATH", "")
ZINIAO_WEBDRIVER_PATH = env_path("ZINIAO_WEBDRIVER_PATH", "")
ZINIAO_BROWSER_VERSION = env_text("ZINIAO_BROWSER_VERSION", "v6")
ZINIAO_SOCKET_PORT = env_int("ZINIAO_SOCKET_PORT", 16851, minimum=1)
ZINIAO_COMPANY = env_text("ZINIAO_COMPANY", "")
ZINIAO_USERNAME = env_text("ZINIAO_USERNAME", "")
ZINIAO_PASSWORD = env_text("ZINIAO_PASSWORD", "")


def ziniao_tool_config_status() -> tuple[bool, str]:
    reasons: list[str] = []
    system_name = str(platform.system() or "").strip()
    if system_name != "Windows":
        reasons.append(f"unsupported platform: {system_name or 'unknown'}")

    client_path_text = str(ZINIAO_CLIENT_PATH or "").strip()
    if not client_path_text:
        reasons.append("ZINIAO_CLIENT_PATH missing")
    else:
        client_path = Path(client_path_text).expanduser()
        if not client_path.exists():
            reasons.append(f"ZINIAO_CLIENT_PATH not found: {client_path}")
        elif not client_path.is_file():
            reasons.append(f"ZINIAO_CLIENT_PATH is not a file: {client_path}")
        elif client_path.suffix.lower() != ".exe":
            reasons.append(f"ZINIAO_CLIENT_PATH is not a Windows exe: {client_path}")

    if not str(ZINIAO_COMPANY or "").strip():
        reasons.append("ZINIAO_COMPANY missing")
    if not str(ZINIAO_USERNAME or "").strip():
        reasons.append("ZINIAO_USERNAME missing")
    if not str(ZINIAO_PASSWORD or "").strip():
        reasons.append("ZINIAO_PASSWORD missing")

    return not reasons, "; ".join(reasons)


def is_ziniao_tool_configured() -> bool:
    configured, _ = ziniao_tool_config_status()
    return configured


__all__ = [
    "ZINIAO_BROWSER_VERSION",
    "ZINIAO_CLIENT_PATH",
    "ZINIAO_COMPANY",
    "ZINIAO_PASSWORD",
    "ZINIAO_SOCKET_PORT",
    "ZINIAO_USERNAME",
    "ZINIAO_WEBDRIVER_PATH",
    "is_ziniao_tool_configured",
    "ziniao_tool_config_status",
]
