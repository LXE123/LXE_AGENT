from __future__ import annotations

from types import SimpleNamespace

from agent_runtime.runtime import load_available_skills_for_session
from agent_runtime.skill_index import load_skill_index
from shared.permission_policy import (
    ALL,
    BOT_ID_AMAZON_REPLENISH,
    BOT_ID_LXE_CLAW,
    BOT_ID_LXE_FBA_AGENT,
    SKILL_TYPE_AMAZON_FBA,
    SKILL_TYPE_AMAZON_REPLENISH,
    USER_LYX,
    USER_ZGL,
    allowed_skill_types_for_bot,
    can_user_access_bot,
    is_known_bot_id,
    resolve_bot_id,
)


def test_policy_user_access_matrix() -> None:
    assert can_user_access_bot(USER_LYX, BOT_ID_LXE_CLAW)
    assert can_user_access_bot(USER_LYX, BOT_ID_LXE_FBA_AGENT)
    assert can_user_access_bot(USER_LYX, BOT_ID_AMAZON_REPLENISH)

    assert can_user_access_bot(USER_ZGL, BOT_ID_LXE_FBA_AGENT)
    assert not can_user_access_bot(USER_ZGL, BOT_ID_LXE_CLAW)
    assert not can_user_access_bot(USER_ZGL, BOT_ID_AMAZON_REPLENISH)

    assert not can_user_access_bot("ou_unknown", BOT_ID_LXE_FBA_AGENT)
    assert not can_user_access_bot(USER_LYX, "cli_unknown")
    assert not is_known_bot_id("cli_unknown")


def test_policy_skill_type_matrix() -> None:
    assert allowed_skill_types_for_bot(BOT_ID_LXE_CLAW) == {ALL}
    assert allowed_skill_types_for_bot(BOT_ID_LXE_FBA_AGENT) == {SKILL_TYPE_AMAZON_FBA}
    assert allowed_skill_types_for_bot(BOT_ID_AMAZON_REPLENISH) == {SKILL_TYPE_AMAZON_REPLENISH}
    assert allowed_skill_types_for_bot("cli_unknown") == set()


def test_resolve_bot_id_uses_stable_platform_identity() -> None:
    feishu_source = SimpleNamespace(
        platform="feishu",
        connector_key="agent",
        raw_data={"app_id": BOT_ID_AMAZON_REPLENISH},
    )
    assert resolve_bot_id(feishu_source) == BOT_ID_AMAZON_REPLENISH

    dingtalk_source = SimpleNamespace(
        platform="dingtalk",
        connector_key="ding-connector",
        raw_data={"robotCode": "ding-robot"},
    )
    assert resolve_bot_id(dingtalk_source) == "ding-robot"


def test_runtime_filters_available_skills_by_bot() -> None:
    index = load_skill_index(force_reload=True)
    manifest_by_name = {manifest.name: manifest for manifest in index.all()}
    all_skill_names = {item.name for item in index.queue(allowed_types={ALL})}

    claw_session = SimpleNamespace(platform="feishu", connector_key="agent", raw_data={"app_id": BOT_ID_LXE_CLAW})
    fba_session = SimpleNamespace(platform="feishu", connector_key="agent", raw_data={"app_id": BOT_ID_LXE_FBA_AGENT})
    replenish_session = SimpleNamespace(
        platform="feishu",
        connector_key="agent",
        raw_data={"app_id": BOT_ID_AMAZON_REPLENISH},
    )

    assert {item.name for item in load_available_skills_for_session(claw_session)} == all_skill_names

    fba_skills = load_available_skills_for_session(fba_session)
    assert fba_skills
    assert {manifest_by_name[item.name].type for item in fba_skills} == {SKILL_TYPE_AMAZON_FBA}

    replenish_skills = load_available_skills_for_session(replenish_session)
    assert replenish_skills
    assert {manifest_by_name[item.name].type for item in replenish_skills} == {SKILL_TYPE_AMAZON_REPLENISH}

