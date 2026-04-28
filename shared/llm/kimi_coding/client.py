from __future__ import annotations

import os

from shared.config import config

PROVIDER_NAME = "kimi_coding"


def provider_label() -> str:
    return "Kimi Coding"


def api_key() -> str:
    return str(
        os.getenv(
            "KIMI_CODE_API_KEY",
            str(
                getattr(
                    config,
                    "KIMI_CODE_API_KEY",
                    getattr(config, "KIMI_API_KEY", ""),
                )
                or ""
            ),
        )
        or ""
    ).strip()


def base_url() -> str:
    return str(
        os.getenv(
            "KIMI_CODE_BASE_URL",
            str(getattr(config, "KIMI_CODE_BASE_URL", "https://api.kimi.com/coding/") or ""),
        )
        or ""
    ).strip() or "https://api.kimi.com/coding/"


def default_model() -> str:
    return str(
        os.getenv(
            "KIMI_CODE_MODEL",
            str(getattr(config, "KIMI_CODE_MODEL", "kimi-code") or ""),
        )
        or ""
    ).strip() or "kimi-code"


def user_agent() -> str:
    return str(
        os.getenv(
            "KIMI_CODE_USER_AGENT",
            str(getattr(config, "KIMI_CODE_USER_AGENT", "claude-code/0.1.0") or ""),
        )
        or ""
    ).strip() or "claude-code/0.1.0"


def anthropic_version() -> str:
    return str(
        os.getenv(
            "KIMI_CODE_ANTHROPIC_VERSION",
            str(getattr(config, "KIMI_CODE_ANTHROPIC_VERSION", "2023-06-01") or ""),
        )
        or ""
    ).strip() or "2023-06-01"
