from __future__ import annotations

from types import SimpleNamespace

from agent_runtime.runtime import load_available_skills_for_session
from agent_runtime.skill_index import load_skill_index
from shared.connector_state import LARK_CLI_SKILL_NAMES
from shared.permission_policy import (
    ALL,
    BOT_ID_AMAZON_REPLENISH,
    BOT_ID_AMAZON_REPLENISH_GROUP_2,
    BOT_ID_AMAZON_REPLENISH_GROUP_3,
    BOT_ID_LXE_CLAW,
    BOT_ID_LXE_FBA_AGENT,
    SKILL_TYPE_AMAZON_FBA,
    SKILL_TYPE_AMAZON_REPLENISH,
    SKILL_TYPE_DEFAULT,
    USER_AMAZON_REPLENISH_GROUP_1_MEMBER,
    USER_AMAZON_REPLENISH_GROUP_2_MEMBER,
    USER_AMAZON_REPLENISH_GROUP_3_MEMBER,
    USER_DEV_GROUP_MEMBER,
    USER_LYX,
    USER_ZQY,
    USER_ZGL,
    allowed_skill_types_for_bot,
    can_user_access_bot,
    is_known_bot_id,
    resolve_bot_id,
    resolve_permission_user_id,
)

BOT_ID_AMAZON_REPLENISH_GROUP_1_MACHINE_2 = "cli_aaa5e06b1bb81bcb"
USER_AMAZON_REPLENISH_GROUP_1_MACHINE_2_MEMBER = "on_5b073ea5ba8e6e5bae65c81cdfc849f4"


def test_policy_user_access_matrix() -> None:
    replenish_bot_ids = {
        BOT_ID_AMAZON_REPLENISH,
        BOT_ID_AMAZON_REPLENISH_GROUP_1_MACHINE_2,
        BOT_ID_AMAZON_REPLENISH_GROUP_2,
        BOT_ID_AMAZON_REPLENISH_GROUP_3,
    }

    assert can_user_access_bot(USER_LYX, BOT_ID_LXE_CLAW)
    assert can_user_access_bot(USER_LYX, BOT_ID_LXE_FBA_AGENT)

    assert can_user_access_bot(USER_ZQY, BOT_ID_LXE_CLAW)
    assert can_user_access_bot(USER_ZQY, BOT_ID_LXE_FBA_AGENT)

    assert can_user_access_bot(USER_ZGL, BOT_ID_LXE_FBA_AGENT)
    assert not can_user_access_bot(USER_ZGL, BOT_ID_LXE_CLAW)
    for bot_id in replenish_bot_ids:
        assert can_user_access_bot(USER_LYX, bot_id)
        assert can_user_access_bot(USER_ZQY, bot_id)
        assert not can_user_access_bot(USER_ZGL, bot_id)

    assert can_user_access_bot(USER_AMAZON_REPLENISH_GROUP_1_MEMBER, BOT_ID_AMAZON_REPLENISH)
    assert not can_user_access_bot(
        USER_AMAZON_REPLENISH_GROUP_1_MEMBER,
        BOT_ID_AMAZON_REPLENISH_GROUP_2,
    )
    assert not can_user_access_bot(
        USER_AMAZON_REPLENISH_GROUP_1_MEMBER,
        BOT_ID_AMAZON_REPLENISH_GROUP_3,
    )
    assert not can_user_access_bot(
        USER_AMAZON_REPLENISH_GROUP_1_MEMBER,
        BOT_ID_AMAZON_REPLENISH_GROUP_1_MACHINE_2,
    )
    assert not can_user_access_bot(USER_AMAZON_REPLENISH_GROUP_1_MEMBER, BOT_ID_LXE_CLAW)
    assert not can_user_access_bot(USER_AMAZON_REPLENISH_GROUP_1_MEMBER, BOT_ID_LXE_FBA_AGENT)

    assert can_user_access_bot(
        USER_AMAZON_REPLENISH_GROUP_1_MACHINE_2_MEMBER,
        BOT_ID_AMAZON_REPLENISH_GROUP_1_MACHINE_2,
    )
    assert not can_user_access_bot(
        USER_AMAZON_REPLENISH_GROUP_1_MACHINE_2_MEMBER,
        BOT_ID_AMAZON_REPLENISH,
    )
    assert not can_user_access_bot(
        USER_AMAZON_REPLENISH_GROUP_1_MACHINE_2_MEMBER,
        BOT_ID_AMAZON_REPLENISH_GROUP_2,
    )
    assert not can_user_access_bot(
        USER_AMAZON_REPLENISH_GROUP_1_MACHINE_2_MEMBER,
        BOT_ID_AMAZON_REPLENISH_GROUP_3,
    )
    assert not can_user_access_bot(
        USER_AMAZON_REPLENISH_GROUP_1_MACHINE_2_MEMBER,
        BOT_ID_LXE_CLAW,
    )
    assert not can_user_access_bot(
        USER_AMAZON_REPLENISH_GROUP_1_MACHINE_2_MEMBER,
        BOT_ID_LXE_FBA_AGENT,
    )

    assert can_user_access_bot(
        USER_AMAZON_REPLENISH_GROUP_2_MEMBER,
        BOT_ID_AMAZON_REPLENISH_GROUP_2,
    )
    assert not can_user_access_bot(USER_AMAZON_REPLENISH_GROUP_2_MEMBER, BOT_ID_AMAZON_REPLENISH)
    assert not can_user_access_bot(
        USER_AMAZON_REPLENISH_GROUP_2_MEMBER,
        BOT_ID_AMAZON_REPLENISH_GROUP_3,
    )
    assert not can_user_access_bot(USER_AMAZON_REPLENISH_GROUP_2_MEMBER, BOT_ID_LXE_CLAW)
    assert not can_user_access_bot(USER_AMAZON_REPLENISH_GROUP_2_MEMBER, BOT_ID_LXE_FBA_AGENT)

    assert can_user_access_bot(
        USER_AMAZON_REPLENISH_GROUP_3_MEMBER,
        BOT_ID_AMAZON_REPLENISH_GROUP_3,
    )
    assert not can_user_access_bot(USER_AMAZON_REPLENISH_GROUP_3_MEMBER, BOT_ID_AMAZON_REPLENISH)
    assert not can_user_access_bot(
        USER_AMAZON_REPLENISH_GROUP_3_MEMBER,
        BOT_ID_AMAZON_REPLENISH_GROUP_2,
    )
    assert not can_user_access_bot(USER_AMAZON_REPLENISH_GROUP_3_MEMBER, BOT_ID_LXE_CLAW)
    assert not can_user_access_bot(USER_AMAZON_REPLENISH_GROUP_3_MEMBER, BOT_ID_LXE_FBA_AGENT)

    for bot_id in {
        BOT_ID_LXE_CLAW,
        BOT_ID_LXE_FBA_AGENT,
        BOT_ID_AMAZON_REPLENISH,
        BOT_ID_AMAZON_REPLENISH_GROUP_1_MACHINE_2,
        BOT_ID_AMAZON_REPLENISH_GROUP_2,
        BOT_ID_AMAZON_REPLENISH_GROUP_3,
    }:
        assert can_user_access_bot(USER_DEV_GROUP_MEMBER, bot_id)

    assert len(
        {
            USER_LYX,
            USER_ZGL,
            USER_ZQY,
            USER_AMAZON_REPLENISH_GROUP_1_MEMBER,
            USER_AMAZON_REPLENISH_GROUP_1_MACHINE_2_MEMBER,
            USER_AMAZON_REPLENISH_GROUP_2_MEMBER,
            USER_AMAZON_REPLENISH_GROUP_3_MEMBER,
            USER_DEV_GROUP_MEMBER,
        }
    ) == 8
    assert not can_user_access_bot("unknown_union_id", BOT_ID_LXE_FBA_AGENT)
    assert not can_user_access_bot(USER_LYX, "cli_unknown")
    assert not is_known_bot_id("cli_unknown")


def test_policy_skill_type_matrix() -> None:
    replenish_bot_ids = {
        BOT_ID_AMAZON_REPLENISH,
        BOT_ID_AMAZON_REPLENISH_GROUP_1_MACHINE_2,
        BOT_ID_AMAZON_REPLENISH_GROUP_2,
        BOT_ID_AMAZON_REPLENISH_GROUP_3,
    }

    assert allowed_skill_types_for_bot(BOT_ID_LXE_CLAW) == {ALL}
    assert allowed_skill_types_for_bot(BOT_ID_LXE_FBA_AGENT) == {
        SKILL_TYPE_AMAZON_FBA,
        SKILL_TYPE_DEFAULT,
    }
    for bot_id in replenish_bot_ids:
        assert allowed_skill_types_for_bot(bot_id) == {
            SKILL_TYPE_AMAZON_REPLENISH,
            SKILL_TYPE_DEFAULT,
        }
    assert allowed_skill_types_for_bot("cli_unknown") == set()


def test_resolve_bot_id_uses_stable_platform_identity() -> None:
    feishu_source = SimpleNamespace(
        platform="feishu",
        raw_data={"app_id": BOT_ID_AMAZON_REPLENISH},
    )
    assert resolve_bot_id(feishu_source) == BOT_ID_AMAZON_REPLENISH

    generic_source = SimpleNamespace(
        platform="api_server",
        raw_data={"bot_id": "api-bot"},
    )
    assert resolve_bot_id(generic_source) == "api-bot"

    persisted_feishu_source = SimpleNamespace(
        source={
            "platform": "feishu",
            "extra": {"bot_app_id": BOT_ID_LXE_FBA_AGENT, "bot_id": "ou_bot"},
        },
    )
    assert resolve_bot_id(persisted_feishu_source) == BOT_ID_LXE_FBA_AGENT

    fallback_source = SimpleNamespace(
        platform="api_server",
        raw_data={},
    )
    assert resolve_bot_id(fallback_source) == ""


def test_resolve_permission_user_id_is_hard_cut_to_union_id() -> None:
    assert resolve_permission_user_id(SimpleNamespace(union_id=USER_LYX, user_id="ou_open_id")) == USER_LYX
    assert resolve_permission_user_id(SimpleNamespace(raw_data={"union_id": USER_ZGL}, user_id="ou_open_id")) == USER_ZGL
    assert resolve_permission_user_id(SimpleNamespace(raw_data={"sender_union_id": USER_ZQY}, user_id="ou_open_id")) == USER_ZQY
    assert resolve_permission_user_id(SimpleNamespace(user_id=USER_LYX, raw_data={"sender_user_id": USER_LYX})) == ""


def test_runtime_filters_available_skills_by_bot(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("LXE_CONNECTOR_STATE_PATH", str(tmp_path / "connector-states.local.json"))

    index = load_skill_index(force_reload=True)
    manifest_by_name = {manifest.name: manifest for manifest in index.all()}
    all_skill_names = {item.name for item in index.queue(allowed_types={ALL})}
    default_disabled_connector_skills = set(LARK_CLI_SKILL_NAMES) | {"dws"}

    claw_session = SimpleNamespace(platform="feishu", raw_data={"app_id": BOT_ID_LXE_CLAW})
    fba_session = SimpleNamespace(platform="feishu", raw_data={"app_id": BOT_ID_LXE_FBA_AGENT})
    assert {item.name for item in load_available_skills_for_session(claw_session)} == (
        all_skill_names - default_disabled_connector_skills
    )

    fba_skills = load_available_skills_for_session(fba_session)
    assert fba_skills
    assert {manifest_by_name[item.name].type for item in fba_skills} == {
        SKILL_TYPE_AMAZON_FBA,
        SKILL_TYPE_DEFAULT,
    }

    for bot_id in {
        BOT_ID_AMAZON_REPLENISH,
        BOT_ID_AMAZON_REPLENISH_GROUP_1_MACHINE_2,
        BOT_ID_AMAZON_REPLENISH_GROUP_2,
        BOT_ID_AMAZON_REPLENISH_GROUP_3,
    }:
        replenish_session = SimpleNamespace(platform="feishu", raw_data={"app_id": bot_id})
        replenish_skills = load_available_skills_for_session(replenish_session)
        assert replenish_skills
        assert {manifest_by_name[item.name].type for item in replenish_skills} == {
            SKILL_TYPE_AMAZON_REPLENISH,
            SKILL_TYPE_DEFAULT,
        }
