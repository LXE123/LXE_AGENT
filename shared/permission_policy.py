from __future__ import annotations

from typing import Any

from platforms.feishu.config import FEISHU_APP_ID
from shared.permission_policy_loader import ALL, PermissionPolicyError, clean_text, load_permission_policy


_POLICY = load_permission_policy()

USER_LYX = _POLICY.user_name_to_union_id.get("LYX", "")
USER_ZQY = _POLICY.user_name_to_union_id.get("ZQY", "")
USER_ZGL = _POLICY.user_name_to_union_id.get("ZGL", "")
USER_AMAZON_REPLENISH_GROUP_1_MEMBER = _POLICY.user_name_to_union_id.get(
    "AMAZON_REPLENISH_GROUP_1_MEMBER",
    "",
)
USER_AMAZON_REPLENISH_GROUP_2_MEMBER = _POLICY.user_name_to_union_id.get(
    "AMAZON_REPLENISH_GROUP_2_MEMBER",
    "",
)
USER_AMAZON_REPLENISH_GROUP_3_MEMBER = _POLICY.user_name_to_union_id.get(
    "AMAZON_REPLENISH_GROUP_3_MEMBER",
    "",
)
USER_DEV_GROUP_MEMBER = _POLICY.user_name_to_union_id.get("DEV_GROUP_MEMBER", "")

BOT_LXE_CLAW = _POLICY.bot_alias_to_key.get("LXE_CLAW", "")
BOT_LXE_FBA_AGENT = _POLICY.bot_alias_to_key.get("AMAZON_FBA", "")
BOT_AMAZON_REPLENISH = _POLICY.bot_alias_to_key.get("AMAZON_REPLENISH", "")
BOT_AMAZON_REPLENISH_GROUP_2 = _POLICY.bot_alias_to_key.get("AMAZON_REPLENISH_GROUP_2", "")
BOT_AMAZON_REPLENISH_GROUP_3 = _POLICY.bot_alias_to_key.get("AMAZON_REPLENISH_GROUP_3", "")

BOT_ID_LXE_CLAW = _POLICY.bot_alias_to_app_id.get("LXE_CLAW", "")
BOT_ID_LXE_FBA_AGENT = _POLICY.bot_alias_to_app_id.get("AMAZON_FBA", "")
BOT_ID_AMAZON_REPLENISH = _POLICY.bot_alias_to_app_id.get("AMAZON_REPLENISH", "")
BOT_ID_AMAZON_REPLENISH_GROUP_2 = _POLICY.bot_alias_to_app_id.get("AMAZON_REPLENISH_GROUP_2", "")
BOT_ID_AMAZON_REPLENISH_GROUP_3 = _POLICY.bot_alias_to_app_id.get("AMAZON_REPLENISH_GROUP_3", "")

SKILL_TYPE_AMAZON_FBA = "amazon_fba"
SKILL_TYPE_AMAZON_REPLENISH = "amazon_replenish"
SKILL_TYPE_DEFAULT = "default"

BOT_ID_TO_KEY = dict(_POLICY.bot_id_to_key)
USER_AGENT_POLICY = {user_id: set(allowed) for user_id, allowed in _POLICY.user_agent_policy.items()}
BOT_SKILL_POLICY = {bot_key: set(skill_types) for bot_key, skill_types in _POLICY.bot_skill_policy.items()}


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
        return clean_text(getattr(source, name))
    except Exception:
        return ""


def bot_key_for_bot_id(bot_id: str) -> str:
    return BOT_ID_TO_KEY.get(clean_text(bot_id), "")


def is_known_bot_id(bot_id: str) -> bool:
    return bool(bot_key_for_bot_id(bot_id))


def resolve_permission_user_id(source: Any) -> str:
    raw = _raw_data(source)
    return (
        _source_text(source, "union_id")
        or clean_text(raw.get("union_id"))
        or clean_text(raw.get("sender_union_id"))
    )


def can_user_access_bot(user_id: str, bot_id: str) -> bool:
    bot_key = bot_key_for_bot_id(bot_id)
    if not bot_key:
        return False
    allowed = set(USER_AGENT_POLICY.get(clean_text(user_id), set()))
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
        clean_text(raw.get("bot_id"))
        or clean_text(raw.get("app_id"))
        or clean_text(raw.get("bot_app_id"))
        or clean_text(extra.get("bot_app_id"))
        or clean_text(extra.get("bot_id"))
    )
    platform = (_source_text(source, "platform") or clean_text(raw.get("platform"))).lower()
    if platform == "feishu":
        return direct_bot_id or clean_text(FEISHU_APP_ID)

    return direct_bot_id


__all__ = [
    "ALL",
    "BOT_AMAZON_REPLENISH",
    "BOT_AMAZON_REPLENISH_GROUP_2",
    "BOT_AMAZON_REPLENISH_GROUP_3",
    "BOT_ID_AMAZON_REPLENISH",
    "BOT_ID_AMAZON_REPLENISH_GROUP_2",
    "BOT_ID_AMAZON_REPLENISH_GROUP_3",
    "BOT_ID_LXE_CLAW",
    "BOT_ID_LXE_FBA_AGENT",
    "BOT_LXE_CLAW",
    "BOT_LXE_FBA_AGENT",
    "BOT_SKILL_POLICY",
    "PermissionPolicyError",
    "SKILL_TYPE_AMAZON_FBA",
    "SKILL_TYPE_AMAZON_REPLENISH",
    "SKILL_TYPE_DEFAULT",
    "USER_AGENT_POLICY",
    "USER_AMAZON_REPLENISH_GROUP_1_MEMBER",
    "USER_AMAZON_REPLENISH_GROUP_2_MEMBER",
    "USER_AMAZON_REPLENISH_GROUP_3_MEMBER",
    "USER_DEV_GROUP_MEMBER",
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
