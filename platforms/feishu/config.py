"""Feishu platform configuration sourced from environment variables."""
from __future__ import annotations

from typing import Any

from shared.env_config import env_flag, env_int, env_text
from shared.log_config import local_logs_enabled


def _config_text(name: str, default: str = "") -> str:
    return env_text(name, default)


def _mask_value(value: str, *, keep: int = 4) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    if len(text) <= keep * 2:
        return "*" * len(text)
    return f"{text[:keep]}...{text[-keep:]}"


FEISHU_APP_ID: str = _config_text("FEISHU_APP_ID")
FEISHU_APP_SECRET: str = _config_text("FEISHU_APP_SECRET")
FEISHU_GATEWAY_ENABLED: bool = env_flag("FEISHU_GATEWAY_ENABLED", True)
FEISHU_WS_AUTO_RESTART_ENABLED: bool = env_flag("FEISHU_WS_AUTO_RESTART_ENABLED", True)
FEISHU_WS_AUTO_RESTART_INTERVAL_SECONDS: int = env_int(
    "FEISHU_WS_AUTO_RESTART_INTERVAL_SECONDS",
    5400,
    minimum=1,
)
FEISHU_WS_AUTO_RESTART_IDLE_CHECK_SECONDS: int = env_int(
    "FEISHU_WS_AUTO_RESTART_IDLE_CHECK_SECONDS",
    30,
    minimum=1,
)
FEISHU_WS_AUTO_RESTART_RETRY_SECONDS: int = env_int(
    "FEISHU_WS_AUTO_RESTART_RETRY_SECONDS",
    60,
    minimum=1,
)
FEISHU_API_HOST: str = "https://open.feishu.cn/open-apis"
FEISHU_RAW_EVENT_DUMP_ENABLED: bool = (
    local_logs_enabled() and env_flag("FEISHU_RAW_EVENT_DUMP_ENABLED", True)
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
        "gateway_enabled": FEISHU_GATEWAY_ENABLED,
        "ws_auto_restart_enabled": FEISHU_WS_AUTO_RESTART_ENABLED,
        "ws_auto_restart_interval_seconds": FEISHU_WS_AUTO_RESTART_INTERVAL_SECONDS,
        "missing_required": missing_required,
        "app_id_masked": _mask_value(FEISHU_APP_ID),
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
    "FEISHU_ENABLED",
    "FEISHU_GATEWAY_ENABLED",
    "FEISHU_RAW_EVENT_DUMP_DIR",
    "FEISHU_RAW_EVENT_DUMP_ENABLED",
    "FEISHU_WS_AUTO_RESTART_ENABLED",
    "FEISHU_WS_AUTO_RESTART_INTERVAL_SECONDS",
    "FEISHU_WS_AUTO_RESTART_IDLE_CHECK_SECONDS",
    "FEISHU_WS_AUTO_RESTART_RETRY_SECONDS",
    "feishu_missing_required_config",
    "feishu_runtime_status",
    "validate_feishu_runtime_config",
]
