from __future__ import annotations

from pathlib import Path

import pytest

from shared.permission_policy_loader import POLICY_PATH_ENV, PermissionPolicyError, load_permission_policy


def _write_policy(path: Path, body: str) -> Path:
    path.write_text(body, encoding="utf-8")
    return path


def _base_policy(users: str) -> str:
    return f"""version: 1
bots:
  AMAZON_FBA:
    key: AMAZON_FBA
    app_id: cli_fba
    skill_types:
      - amazon_fba
      - default
  AMAZON_REPLENISH_GROUP_2:
    key: Amazon_备货二组
    app_id: cli_group_2
    skill_types:
      - amazon_replenish
      - default
users:
{users}
"""


def test_load_default_permission_policy() -> None:
    policy = load_permission_policy()

    assert policy.bot_alias_to_app_id["AMAZON_FBA_MACHINE_2"] == "cli_aaa5e081aa211bee"
    assert policy.bot_alias_to_key["AMAZON_FBA_MACHINE_2"] == "AMAZON_FBA"
    assert policy.user_name_to_union_id["AMAZON_FBA_MACHINE_2_MEMBER"] == (
        "on_d73c763c561e81ed7e554dd59e286095"
    )
    assert policy.user_name_to_allow_aliases["AMAZON_FBA_MACHINE_2_MEMBER"] == {
        "AMAZON_FBA_MACHINE_2",
    }
    assert policy.user_agent_policy["on_d73c763c561e81ed7e554dd59e286095"] == {"AMAZON_FBA"}
    assert policy.bot_skill_policy["AMAZON_FBA"] == {"amazon_fba", "default"}

    assert policy.bot_alias_to_app_id["AMAZON_REPLENISH_GROUP_1_MACHINE_2"] == "cli_aaa5e06b1bb81bcb"
    assert policy.bot_alias_to_key["AMAZON_REPLENISH_GROUP_1_MACHINE_2"] == "AMAZON-备货一组-二号机"
    assert policy.user_name_to_union_id["AMAZON_REPLENISH_GROUP_1_MACHINE_2_MEMBER"] == (
        "on_5b073ea5ba8e6e5bae65c81cdfc849f4"
    )
    assert policy.user_name_to_allow_aliases["AMAZON_REPLENISH_GROUP_1_MACHINE_2_MEMBER"] == {
        "AMAZON_REPLENISH_GROUP_1_MACHINE_2",
    }
    assert policy.user_agent_policy["on_5b073ea5ba8e6e5bae65c81cdfc849f4"] == {
        "AMAZON-备货一组-二号机",
    }
    assert policy.bot_skill_policy["AMAZON-备货一组-二号机"] == {"amazon_replenish", "default"}

    assert policy.bot_alias_to_app_id["AMAZON_REPLENISH_GROUP_2"] == "cli_aaad7fee66b8dbda"
    assert policy.bot_alias_to_key["AMAZON_REPLENISH_GROUP_2"] == "Amazon_备货二组"
    assert policy.user_name_to_union_id["AMAZON_REPLENISH_GROUP_2_MEMBER"] == (
        "on_83a449091b58ce155969be6c2684e251"
    )
    assert policy.user_name_to_allow_aliases["AMAZON_REPLENISH_GROUP_2_MEMBER"] == {
        "AMAZON_REPLENISH_GROUP_2",
    }
    assert policy.user_agent_policy["on_83a449091b58ce155969be6c2684e251"] == {"Amazon_备货二组"}


def test_load_permission_policy_can_use_env_override(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    policy_path = _write_policy(
        tmp_path / "permission_policy.yaml",
        _base_policy(
            """  FIRST:
    union_id: on_first
    allow:
      - AMAZON_FBA
"""
        ),
    )
    monkeypatch.setenv(POLICY_PATH_ENV, str(policy_path))

    policy = load_permission_policy()

    assert policy.path == policy_path
    assert policy.user_agent_policy["on_first"] == {"AMAZON_FBA"}


def test_load_permission_policy_allows_shared_key_with_matching_skills(tmp_path: Path) -> None:
    policy_path = _write_policy(
        tmp_path / "permission_policy.yaml",
        """version: 1
bots:
  AMAZON_FBA:
    key: AMAZON_FBA
    app_id: cli_fba
    skill_types:
      - amazon_fba
      - default
  AMAZON_FBA_MACHINE_2:
    key: AMAZON_FBA
    app_id: cli_fba_machine_2
    skill_types:
      - amazon_fba
      - default
users:
  SECOND_MACHINE:
    union_id: on_second_machine
    allow:
      - AMAZON_FBA_MACHINE_2
""",
    )

    policy = load_permission_policy(policy_path)

    assert policy.bot_id_to_key["cli_fba"] == "AMAZON_FBA"
    assert policy.bot_id_to_key["cli_fba_machine_2"] == "AMAZON_FBA"
    assert policy.user_agent_policy["on_second_machine"] == {"AMAZON_FBA"}
    assert policy.bot_skill_policy["AMAZON_FBA"] == {"amazon_fba", "default"}


@pytest.mark.parametrize(
    ("body", "message"),
    [
        (
            _base_policy(
                """  FIRST:
    union_id: on_same
    allow:
      - AMAZON_FBA
  SECOND:
    union_id: on_same
    allow:
      - AMAZON_REPLENISH_GROUP_2
"""
            ),
            "duplicate user union_id",
        ),
        (
            """version: 1
bots:
  AMAZON_FBA:
    key: AMAZON_FBA
    app_id: cli_duplicate
    skill_types:
      - amazon_fba
  AMAZON_REPLENISH_GROUP_2:
    key: Amazon_备货二组
    app_id: cli_duplicate
    skill_types:
      - amazon_replenish
users:
  FIRST:
    union_id: on_first
    allow:
      - AMAZON_FBA
""",
            "duplicate bot app_id",
        ),
        (
            """version: 1
bots:
  AMAZON_FBA:
    key: AMAZON_FBA
    app_id: cli_fba
    skill_types:
      - amazon_fba
      - default
  AMAZON_FBA_MACHINE_2:
    key: AMAZON_FBA
    app_id: cli_fba_machine_2
    skill_types:
      - default
users:
  FIRST:
    union_id: on_first
    allow:
      - AMAZON_FBA
""",
            "must match shared permission key",
        ),
        (
            _base_policy(
                """  FIRST:
    union_id: on_first
    allow:
      - UNKNOWN_BOT
"""
            ),
            "unknown bot alias",
        ),
        (
            """version: 1
bots:
  AMAZON_FBA:
    key: AMAZON_FBA
    app_id: cli_fba
    skill_types: []
users:
  FIRST:
    union_id: on_first
    allow:
      - AMAZON_FBA
""",
            "skill_types must not be empty",
        ),
        (
            _base_policy(
                """  FIRST:
    union_id: on_first
    allow:
      - "*"
      - AMAZON_FBA
"""
            ),
            "cannot mix",
        ),
    ],
)
def test_load_permission_policy_rejects_invalid_yaml(tmp_path: Path, body: str, message: str) -> None:
    policy_path = _write_policy(tmp_path / "permission_policy.yaml", body)

    with pytest.raises(PermissionPolicyError, match=message):
        load_permission_policy(policy_path)


def test_load_permission_policy_rejects_duplicate_yaml_keys(tmp_path: Path) -> None:
    policy_path = _write_policy(
        tmp_path / "permission_policy.yaml",
        """version: 1
bots:
  AMAZON_FBA:
    key: AMAZON_FBA
    app_id: cli_fba
    skill_types:
      - amazon_fba
  AMAZON_FBA:
    key: AMAZON_FBA_DUP
    app_id: cli_fba_dup
    skill_types:
      - default
users: {}
""",
    )

    with pytest.raises(PermissionPolicyError, match="duplicate YAML key"):
        load_permission_policy(policy_path)
