from __future__ import annotations

import platform
from pathlib import Path

from shared.env_config import env_flag, env_int, env_path, env_text


ZINIAO_REGISTER_PLANNER_TOOLS = env_flag("ZINIAO_REGISTER_PLANNER_TOOLS", True)
ZINIAO_CLIENT_PATH = env_path("ZINIAO_CLIENT_PATH", "")
ZINIAO_WEBDRIVER_PATH = env_path("ZINIAO_WEBDRIVER_PATH", "")
ZINIAO_BROWSER_VERSION = env_text("ZINIAO_BROWSER_VERSION", "v6")
ZINIAO_SOCKET_PORT = env_int("ZINIAO_SOCKET_PORT", 16851, minimum=1)
ZINIAO_COMPANY = env_text("ZINIAO_COMPANY", "")
ZINIAO_USERNAME = env_text("ZINIAO_USERNAME", "")
ZINIAO_PASSWORD = env_text("ZINIAO_PASSWORD", "")


def is_ziniao_planner_tools_enabled() -> bool:
    return bool(ZINIAO_REGISTER_PLANNER_TOOLS)


def _is_macos_app_name(client_path_text: str) -> bool:
    return client_path_text == "ziniao"


def _validate_client_path(client_path_text: str, *, system_name: str) -> list[str]:
    if not client_path_text:
        return ["ZINIAO_CLIENT_PATH missing"]

    if system_name == "Darwin" and _is_macos_app_name(client_path_text):
        return []

    client_path = Path(client_path_text).expanduser()
    if not client_path.exists():
        return [f"ZINIAO_CLIENT_PATH not found: {client_path}"]

    if system_name == "Windows":
        if not client_path.is_file():
            return [f"ZINIAO_CLIENT_PATH is not a file: {client_path}"]
        if client_path.suffix.lower() != ".exe":
            return [f"ZINIAO_CLIENT_PATH is not a Windows exe: {client_path}"]
        return []

    if system_name == "Darwin":
        if client_path.is_file():
            return []
        if client_path.suffix.lower() == ".app" and client_path.is_dir():
            return []
        return [f"ZINIAO_CLIENT_PATH is not a macOS app or executable file: {client_path}"]

    if system_name == "Linux":
        if not client_path.is_file():
            return [f"ZINIAO_CLIENT_PATH is not a file: {client_path}"]
        return []

    return [f"unsupported platform: {system_name or 'unknown'}"]


def _validate_webdriver_path(webdriver_path_text: str, *, system_name: str) -> list[str]:
    if system_name not in {"Windows", "Darwin"}:
        return []
    if not webdriver_path_text:
        return ["ZINIAO_WEBDRIVER_PATH missing"]
    webdriver_path = Path(webdriver_path_text).expanduser()
    if webdriver_path.exists() and not webdriver_path.is_dir():
        return [f"ZINIAO_WEBDRIVER_PATH is not a directory: {webdriver_path}"]
    return []


def ziniao_tool_config_status() -> tuple[bool, str]:
    reasons: list[str] = []
    if not is_ziniao_planner_tools_enabled():
        return False, "ZINIAO_REGISTER_PLANNER_TOOLS disabled"

    system_name = str(platform.system() or "").strip()
    client_path_text = str(ZINIAO_CLIENT_PATH or "").strip()
    webdriver_path_text = str(ZINIAO_WEBDRIVER_PATH or "").strip()

    reasons.extend(_validate_client_path(client_path_text, system_name=system_name))
    reasons.extend(_validate_webdriver_path(webdriver_path_text, system_name=system_name))

    if not str(ZINIAO_COMPANY or "").strip():
        reasons.append("ZINIAO_COMPANY missing")
    if not str(ZINIAO_USERNAME or "").strip():
        reasons.append("ZINIAO_USERNAME missing")
    if not str(ZINIAO_PASSWORD or "").strip():
        reasons.append("ZINIAO_PASSWORD missing")

    return not reasons, "; ".join(reasons)


__all__ = [
    "ZINIAO_BROWSER_VERSION",
    "ZINIAO_CLIENT_PATH",
    "ZINIAO_COMPANY",
    "ZINIAO_PASSWORD",
    "ZINIAO_REGISTER_PLANNER_TOOLS",
    "ZINIAO_SOCKET_PORT",
    "ZINIAO_USERNAME",
    "ZINIAO_WEBDRIVER_PATH",
    "is_ziniao_planner_tools_enabled",
    "ziniao_tool_config_status",
]
