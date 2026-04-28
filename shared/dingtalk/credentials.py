from __future__ import annotations

from typing import Any

from shared.config import config

AGENT_BOT = "agent"
DEFAULT_BOT = AGENT_BOT


def _clean_text(value: Any) -> str:
    return str(value or "").strip()


def agent_connector_key() -> str:
    return _clean_text(getattr(config, "DINGTALK_AGENT_CLIENT_ID", "")) or AGENT_BOT


def connector_aliases_for_bot(bot_name: str) -> tuple[str, ...]:
    canonical = normalize_bot_name(bot_name, default=bot_name)
    aliases: list[str] = []
    for item in (
        canonical,
        AGENT_BOT if canonical == agent_connector_key() else "",
    ):
        safe_item = _clean_text(item)
        if safe_item and safe_item not in aliases:
            aliases.append(safe_item)
    return tuple(aliases)


def _normalize_default(default: str) -> str:
    text = _clean_text(default)
    if text.lower() == AGENT_BOT:
        return agent_connector_key()
    return text


def normalize_bot_name(value: Any, *, default: str = DEFAULT_BOT) -> str:
    text = _clean_text(value)
    if not text:
        return _normalize_default(default)

    lowered = text.lower()
    agent_key = agent_connector_key()
    if lowered in {AGENT_BOT, agent_key.lower()}:
        return agent_key
    return text


def bot_name_from_data(data: dict[str, Any] | None, *, default: str = DEFAULT_BOT) -> str:
    raw = dict(data or {})
    return normalize_bot_name(
        raw.get("connector_key")
        or raw.get("robotCode")
        or raw.get("_bot_name")
        or raw.get("bot_name")
        or raw.get("botName"),
        default=default,
    )


def robot_code_for_bot(bot_name: str) -> str:
    safe_bot = normalize_bot_name(bot_name)
    if safe_bot == agent_connector_key():
        return _clean_text(getattr(config, "DINGTALK_AGENT_CLIENT_ID", "")) or safe_bot
    return safe_bot


def client_secret_for_bot(bot_name: str) -> str:
    safe_bot = normalize_bot_name(bot_name)
    if safe_bot == agent_connector_key():
        return _clean_text(getattr(config, "DINGTALK_AGENT_CLIENT_SECRET", ""))
    return ""


def credentials_for_bot(bot_name: str) -> tuple[str, str]:
    safe_bot = normalize_bot_name(bot_name)
    return robot_code_for_bot(safe_bot), client_secret_for_bot(safe_bot)


def inject_bot_data(raw_data: dict[str, Any] | None, bot_name: str) -> dict[str, Any]:
    payload = dict(raw_data or {})
    safe_bot = normalize_bot_name(bot_name)
    payload["connector_key"] = safe_bot
    payload["_bot_name"] = safe_bot
    payload["robotCode"] = robot_code_for_bot(safe_bot)
    return payload
