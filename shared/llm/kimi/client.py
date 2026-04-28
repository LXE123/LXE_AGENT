from __future__ import annotations

import os

from shared.config import config

PROVIDER_NAME = "kimi"


def provider_label() -> str:
    return "Kimi"


def api_key() -> str:
    return str(os.getenv("KIMI_API_KEY", str(getattr(config, "KIMI_API_KEY", "") or "")) or "").strip()


def base_url() -> str:
    return str(
        os.getenv("KIMI_BASE_URL", str(getattr(config, "KIMI_BASE_URL", "https://api.moonshot.cn/v1") or ""))
        or ""
    ).strip() or "https://api.moonshot.cn/v1"


def default_model() -> str:
    return str(
        os.getenv("KIMI_CHAT_MODEL", str(getattr(config, "KIMI_CHAT_MODEL", "kimi-k2-turbo-preview") or ""))
        or ""
    ).strip() or "kimi-k2-turbo-preview"
