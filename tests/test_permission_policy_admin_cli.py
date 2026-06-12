from __future__ import annotations

import subprocess
import sys
from pathlib import Path

from shared.permission_policy_loader import load_permission_policy


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "permission_policy_admin.py"


def _write_policy(path: Path) -> Path:
    path.write_text(
        """version: 1
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
  LXE_CLAW:
    key: LXE_CLAW
    app_id: cli_claw
    skill_types:
      - "*"
users:
  MULTI_USER:
    union_id: on_multi
    allow:
      - AMAZON_FBA
      - AMAZON_REPLENISH_GROUP_2
  REMOVE_ME:
    union_id: on_remove
    allow:
      - AMAZON_FBA
""",
        encoding="utf-8",
    )
    return path


def _run_cli(policy_path: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(SCRIPT), "--policy", str(policy_path), *args],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )


def test_permission_policy_admin_grant_and_show_user(tmp_path: Path) -> None:
    policy_path = _write_policy(tmp_path / "permission_policy.yaml")

    result = _run_cli(
        policy_path,
        "grant",
        "--union-id",
        "on_new",
        "--name",
        "NEW_USER",
        "--bot",
        "AMAZON_REPLENISH_GROUP_2",
    )

    assert result.returncode == 0, result.stderr
    policy = load_permission_policy(policy_path)
    assert policy.user_name_to_union_id["NEW_USER"] == "on_new"
    assert policy.user_name_to_allow_aliases["NEW_USER"] == {"AMAZON_REPLENISH_GROUP_2"}
    assert policy.user_agent_policy["on_new"] == {"Amazon_备货二组"}

    show = _run_cli(policy_path, "show-user", "--union-id", "on_new")
    assert show.returncode == 0, show.stderr
    assert "name: NEW_USER" in show.stdout
    assert "allow: AMAZON_REPLENISH_GROUP_2" in show.stdout


def test_permission_policy_admin_revoke_single_bot(tmp_path: Path) -> None:
    policy_path = _write_policy(tmp_path / "permission_policy.yaml")

    result = _run_cli(
        policy_path,
        "revoke",
        "--union-id",
        "on_multi",
        "--bot",
        "AMAZON_REPLENISH_GROUP_2",
    )

    assert result.returncode == 0, result.stderr
    policy = load_permission_policy(policy_path)
    assert policy.user_name_to_allow_aliases["MULTI_USER"] == {"AMAZON_FBA"}
    assert policy.user_agent_policy["on_multi"] == {"AMAZON_FBA"}


def test_permission_policy_admin_remove_user(tmp_path: Path) -> None:
    policy_path = _write_policy(tmp_path / "permission_policy.yaml")

    result = _run_cli(policy_path, "remove-user", "--union-id", "on_remove")

    assert result.returncode == 0, result.stderr
    policy = load_permission_policy(policy_path)
    assert "REMOVE_ME" not in policy.user_name_to_union_id
    assert "on_remove" not in policy.user_agent_policy


def test_permission_policy_admin_validate_reports_errors(tmp_path: Path) -> None:
    policy_path = tmp_path / "permission_policy.yaml"
    policy_path.write_text(
        """version: 1
bots:
  AMAZON_FBA:
    key: AMAZON_FBA
    app_id: cli_fba
    skill_types:
      - amazon_fba
users:
  BAD_USER:
    union_id: on_bad
    allow:
      - UNKNOWN_BOT
""",
        encoding="utf-8",
    )

    result = _run_cli(policy_path, "validate")

    assert result.returncode == 1
    assert "unknown bot alias" in result.stderr
