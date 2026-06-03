"""Feishu platform configuration sourced from shared.config."""
from __future__ import annotations

from typing import Any

from shared.config import config as shared_config


def _config_text(name: str, default: str = "") -> str:
    return str(getattr(shared_config, name, default) or "").strip()


def _mask_value(value: str, *, keep: int = 4) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    if len(text) <= keep * 2:
        return "*" * len(text)
    return f"{text[:keep]}...{text[-keep:]}"


FEISHU_APP_ID: str = _config_text("FEISHU_APP_ID")
FEISHU_APP_SECRET: str = _config_text("FEISHU_APP_SECRET")
FEISHU_BOT_OPEN_ID: str = _config_text("FEISHU_BOT_OPEN_ID")
FEISHU_API_HOST: str = _config_text("FEISHU_API_HOST", "https://open.feishu.cn/open-apis")
FEISHU_RAW_EVENT_DUMP_ENABLED: bool = bool(
    getattr(shared_config, "FEISHU_RAW_EVENT_DUMP_ENABLED", False)
)
FEISHU_RAW_EVENT_DUMP_DIR: str = _config_text(
    "FEISHU_RAW_EVENT_DUMP_DIR",
    "logs/feishu_raw_events",
)


def feishu_missing_required_config() -> list[str]:
    missing: list[str] = []
    if not FEISHU_APP_ID:
        missing.append("FEISHU_APP_ID")
    if not FEISHU_APP_SECRET:
        missing.append("FEISHU_APP_SECRET")
    return missing


FEISHU_ENABLED: bool = not feishu_missing_required_config()


def feishu_runtime_status() -> dict[str, Any]:
    missing_required = feishu_missing_required_config()
    return {
        "enabled": not missing_required,
        "missing_required": missing_required,
        "app_id_masked": _mask_value(FEISHU_APP_ID),
        "bot_open_id_configured": bool(FEISHU_BOT_OPEN_ID),
        "api_host": FEISHU_API_HOST,
        "raw_event_dump_enabled": FEISHU_RAW_EVENT_DUMP_ENABLED,
        "raw_event_dump_dir": FEISHU_RAW_EVENT_DUMP_DIR,
    }


def validate_feishu_runtime_config() -> None:
    missing_required = feishu_missing_required_config()
    if missing_required:
        raise RuntimeError(
            "Feishu gateway config incomplete: missing "
            + ", ".join(missing_required)
        )


__all__ = [
    "FEISHU_API_HOST",
    "FEISHU_APP_ID",
    "FEISHU_APP_SECRET",
    "FEISHU_BOT_OPEN_ID",
    "FEISHU_ENABLED",
    "FEISHU_RAW_EVENT_DUMP_DIR",
    "FEISHU_RAW_EVENT_DUMP_ENABLED",
    "feishu_missing_required_config",
    "feishu_runtime_status",
    "validate_feishu_runtime_config",
]
