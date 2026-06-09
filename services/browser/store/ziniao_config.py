from __future__ import annotations

from shared.env_config import env_int, env_path, env_text


ZINIAO_CLIENT_PATH = env_path("ZINIAO_CLIENT_PATH", "")
ZINIAO_WEBDRIVER_PATH = env_path("ZINIAO_WEBDRIVER_PATH", "")
ZINIAO_BROWSER_VERSION = env_text("ZINIAO_BROWSER_VERSION", "v6")
ZINIAO_SOCKET_PORT = env_int("ZINIAO_SOCKET_PORT", 16851, minimum=1)
ZINIAO_COMPANY = env_text("ZINIAO_COMPANY", "")
ZINIAO_USERNAME = env_text("ZINIAO_USERNAME", "")
ZINIAO_PASSWORD = env_text("ZINIAO_PASSWORD", "")


__all__ = [
    "ZINIAO_BROWSER_VERSION",
    "ZINIAO_CLIENT_PATH",
    "ZINIAO_COMPANY",
    "ZINIAO_PASSWORD",
    "ZINIAO_SOCKET_PORT",
    "ZINIAO_USERNAME",
    "ZINIAO_WEBDRIVER_PATH",
]
