from __future__ import annotations

from typing import Any

from platforms.feishu.config import FEISHU_APP_ID


ALL = "*"

USER_LYX = "on_ceda19124b8eef9e07c9e7aaec989043"
USER_ZQY = "on_a71a8f244e06602e0f37b3abe68d6ac3"
USER_ZGL = "on_09af343a868258c25a3e53ad0464caa4"

BOT_LXE_CLAW = "LXE_CLAW"
BOT_LXE_FBA_AGENT = "AMAZON_FBA"
BOT_AMAZON_REPLENISH = "Amazon_备货"

BOT_ID_LXE_CLAW = "cli_a93d57dc47385cc0"
BOT_ID_LXE_FBA_AGENT = "cli_a97ac28237781bd8"
BOT_ID_AMAZON_REPLENISH = "cli_aa9d657db5385cdd"
BOT_ID_AMAZON_REPLENISH_GROUP_3 = "cli_a979a369743a1bd3"
BOT_ID_AMAZON_REPLENISH_GROUP_2 = "cli_aaad7fee66b8dbda"

SKILL_TYPE_AMAZON_FBA = "amazon_fba"
SKILL_TYPE_AMAZON_REPLENISH = "amazon_replenish"
SKILL_TYPE_DEFAULT = "default"

BOT_ID_TO_KEY = {
    BOT_ID_LXE_CLAW: BOT_LXE_CLAW,
    BOT_ID_LXE_FBA_AGENT: BOT_LXE_FBA_AGENT,
    BOT_ID_AMAZON_REPLENISH: BOT_AMAZON_REPLENISH,
    BOT_ID_AMAZON_REPLENISH_GROUP_3: BOT_AMAZON_REPLENISH,
    BOT_ID_AMAZON_REPLENISH_GROUP_2: BOT_AMAZON_REPLENISH,
}

USER_AGENT_POLICY = {
    USER_LYX: {ALL},
    USER_ZQY: {ALL},
    USER_ZGL: {BOT_LXE_FBA_AGENT},
}

BOT_SKILL_POLICY = {
    BOT_LXE_CLAW: {ALL},
    BOT_LXE_FBA_AGENT: {SKILL_TYPE_AMAZON_FBA, SKILL_TYPE_DEFAULT},
    BOT_AMAZON_REPLENISH: {SKILL_TYPE_AMAZON_REPLENISH, SKILL_TYPE_DEFAULT},
}


def _clean_text(value: Any) -> str:
    return str(value or "").strip()


def _raw_data(source: Any) -> dict[str, Any]:
    raw = getattr(source, "raw_data", None)
    if isinstance(raw, dict):
        return dict(raw)
    raw = getattr(source, "source", None)
    if isinstance(raw, dict):
        return dict(raw)
    return {}


def _extra_data(source: Any) -> dict[str, Any]:
    raw = _raw_data(source)
    extra = raw.get("extra")
    return dict(extra) if isinstance(extra, dict) else {}


def _source_text(source: Any, name: str) -> str:
    try:
        return _clean_text(getattr(source, name))
    except Exception:
        return ""


def bot_key_for_bot_id(bot_id: str) -> str:
    return BOT_ID_TO_KEY.get(_clean_text(bot_id), "")


def is_known_bot_id(bot_id: str) -> bool:
    return bool(bot_key_for_bot_id(bot_id))


def resolve_permission_user_id(source: Any) -> str:
    raw = _raw_data(source)
    return (
        _source_text(source, "union_id")
        or _clean_text(raw.get("union_id"))
        or _clean_text(raw.get("sender_union_id"))
    )


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
    extra = _extra_data(source)
    direct_bot_id = (
        _clean_text(raw.get("bot_id"))
        or _clean_text(raw.get("app_id"))
        or _clean_text(raw.get("bot_app_id"))
        or _clean_text(extra.get("bot_app_id"))
        or _clean_text(extra.get("bot_id"))
    )
    platform = (_source_text(source, "platform") or _clean_text(raw.get("platform"))).lower()
    if platform == "feishu":
        return direct_bot_id or _clean_text(FEISHU_APP_ID)

    return direct_bot_id


__all__ = [
    "ALL",
    "BOT_AMAZON_REPLENISH",
    "BOT_ID_AMAZON_REPLENISH",
    "BOT_ID_AMAZON_REPLENISH_GROUP_2",
    "BOT_ID_AMAZON_REPLENISH_GROUP_3",
    "BOT_ID_LXE_CLAW",
    "BOT_ID_LXE_FBA_AGENT",
    "BOT_LXE_CLAW",
    "BOT_LXE_FBA_AGENT",
    "BOT_SKILL_POLICY",
    "SKILL_TYPE_AMAZON_FBA",
    "SKILL_TYPE_AMAZON_REPLENISH",
    "SKILL_TYPE_DEFAULT",
    "USER_AGENT_POLICY",
    "USER_LYX",
    "USER_ZQY",
    "USER_ZGL",
    "allowed_skill_types_for_bot",
    "bot_key_for_bot_id",
    "can_user_access_bot",
    "is_known_bot_id",
    "resolve_bot_id",
    "resolve_permission_user_id",
]
