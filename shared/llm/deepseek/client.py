from __future__ import annotations

import os

from shared.config import config

PROVIDER_NAME = "deepseek"


def provider_label() -> str:
    return "DeepSeek"


def api_key() -> str:
    return str(os.getenv("DEEPSEEK_API", str(getattr(config, "DEEPSEEK_API", "") or "")) or "").strip()


def base_url() -> str:
    return str(
        os.getenv("DEEPSEEK_BASE_URL", str(getattr(config, "DEEPSEEK_BASE_URL", "https://api.deepseek.com") or ""))
        or ""
    ).strip() or "https://api.deepseek.com"


def default_model() -> str:
    return str(
        os.getenv("DEEPSEEK_CHAT_MODEL", str(getattr(config, "DEEPSEEK_CHAT_MODEL", "deepseek-chat") or ""))
        or ""
    ).strip() or "deepseek-chat"
