from __future__ import annotations

import os

from shared.config import config

PROVIDER_NAME = "glm"


def provider_label() -> str:
    return "GLM"


def api_key() -> str:
    candidates = (
        os.getenv("GLM_API_KEY", ""),
        os.getenv("ZHIPU_API_KEY", ""),
        os.getenv("ZHIPUAI_API_KEY", ""),
        str(getattr(config, "GLM_API_KEY", "") or ""),
    )
    for candidate in candidates:
        token = str(candidate or "").strip()
        if token:
            return token
    return ""


def base_url() -> str:
    return str(
        os.getenv(
            "GLM_BASE_URL",
            str(getattr(config, "GLM_BASE_URL", "https://open.bigmodel.cn/api/anthropic") or ""),
        )
        or ""
    ).strip() or "https://open.bigmodel.cn/api/anthropic"


def default_model() -> str:
    return str(
        os.getenv(
            "GLM_MODEL",
            str(getattr(config, "GLM_MODEL", "glm-5v-turbo") or ""),
        )
        or ""
    ).strip() or "glm-5v-turbo"


def anthropic_version() -> str:
    return str(
        os.getenv(
            "GLM_ANTHROPIC_VERSION",
            str(getattr(config, "GLM_ANTHROPIC_VERSION", "2023-06-01") or ""),
        )
        or ""
    ).strip() or "2023-06-01"
