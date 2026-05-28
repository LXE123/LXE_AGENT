from __future__ import annotations

from typing import Any

from shared.config import config


ALL = "*"

USER_LYX = "ou_0f27213c7af8393a910e071f8d897194"
USER_ZGL = "ou_7ce2a0ec83356336d5187a6fee0ebbd3"

BOT_LXE_CLAW = "LXE_CLAW"
BOT_LXE_FBA_AGENT = "AMAZON_FBA"
BOT_AMAZON_REPLENISH = "Amazon_备货"

BOT_ID_LXE_CLAW = "cli_a97ac28237781bd8"
BOT_ID_LXE_FBA_AGENT = "cli_a93d57dc47385cc0"
BOT_ID_AMAZON_REPLENISH = "cli_aa9d657db5385cdd"

SKILL_TYPE_AMAZON_FBA = "amazon_fba"
SKILL_TYPE_AMAZON_REPLENISH = "amazon_replenish"

BOT_ID_TO_KEY = {
    BOT_ID_LXE_CLAW: BOT_LXE_CLAW,
    BOT_ID_LXE_FBA_AGENT: BOT_LXE_FBA_AGENT,
    BOT_ID_AMAZON_REPLENISH: BOT_AMAZON_REPLENISH,
}

USER_AGENT_POLICY = {
    USER_LYX: {ALL},
    USER_ZGL: {BOT_LXE_FBA_AGENT},
}

BOT_SKILL_POLICY = {
    BOT_LXE_CLAW: {ALL},
    BOT_LXE_FBA_AGENT: {SKILL_TYPE_AMAZON_FBA},
    BOT_AMAZON_REPLENISH: {SKILL_TYPE_AMAZON_REPLENISH},
}


def _clean_text(value: Any) -> str:
    return str(value or "").strip()


def _raw_data(source: Any) -> dict[str, Any]:
    raw = getattr(source, "raw_data", None)
    if isinstance(raw, dict):
        return dict(raw)
    return {}


def _source_text(source: Any, name: str) -> str:
    try:
        return _clean_text(getattr(source, name))
    except Exception:
        return ""


def bot_key_for_bot_id(bot_id: str) -> str:
    return BOT_ID_TO_KEY.get(_clean_text(bot_id), "")


def is_known_bot_id(bot_id: str) -> bool:
    return bool(bot_key_for_bot_id(bot_id))


def can_user_access_bot(user_id: str, bot_id: str) -> bool:
    bot_key = bot_key_for_bot_id(bot_id)
    if not bot_key:
        return False
    allowed = set(USER_AGENT_POLICY.get(_clean_text(user_id), set()))
    return ALL in allowed or bot_key in allowed


def allowed_skill_types_for_bot(bot_id: str) -> set[str]:
    bot_key = bot_key_for_bot_id(bot_id)
    if not bot_key:
        return set()
    return set(BOT_SKILL_POLICY.get(bot_key, set()))


def resolve_bot_id(source: Any) -> str:
    raw = _raw_data(source)
    direct_bot_id = (
        _clean_text(raw.get("bot_id"))
        or _clean_text(raw.get("app_id"))
        or _clean_text(raw.get("bot_app_id"))
    )
    platform = (_source_text(source, "platform") or _clean_text(raw.get("platform"))).lower()
    connector_key = _source_text(source, "connector_key") or _clean_text(raw.get("connector_key"))

    if platform == "feishu":
        return direct_bot_id or _clean_text(getattr(config, "FEISHU_APP_ID", ""))

    if platform == "dingtalk":
        return (
            direct_bot_id
            or _clean_text(raw.get("robotCode"))
            or _clean_text(raw.get("_bot_name"))
            or connector_key
        )

    return direct_bot_id or connector_key


__all__ = [
    "ALL",
    "BOT_AMAZON_REPLENISH",
    "BOT_ID_AMAZON_REPLENISH",
    "BOT_ID_LXE_CLAW",
    "BOT_ID_LXE_FBA_AGENT",
    "BOT_LXE_CLAW",
    "BOT_LXE_FBA_AGENT",
    "BOT_SKILL_POLICY",
    "SKILL_TYPE_AMAZON_FBA",
    "SKILL_TYPE_AMAZON_REPLENISH",
    "USER_AGENT_POLICY",
    "USER_LYX",
    "USER_ZGL",
    "allowed_skill_types_for_bot",
    "bot_key_for_bot_id",
    "can_user_access_bot",
    "is_known_bot_id",
    "resolve_bot_id",
]
