from __future__ import annotations

import argparse
import os
import sys
import tempfile
from pathlib import Path
from typing import Any

import yaml


REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from shared.permission_policy_loader import (  # noqa: E402
    ALL,
    PermissionPolicyError,
    build_permission_policy,
    clean_text,
    load_permission_policy,
    load_permission_policy_data,
    permission_policy_path,
)


def _sorted_values(values: list[str]) -> list[str]:
    return sorted(values, key=lambda item: (item != ALL, item.casefold()))


def _canonical_data(data: dict[str, Any]) -> dict[str, Any]:
    bots = data.get("bots") if isinstance(data.get("bots"), dict) else {}
    users = data.get("users") if isinstance(data.get("users"), dict) else {}

    canonical_bots: dict[str, Any] = {}
    for alias in sorted(bots):
        raw_bot = dict(bots[alias] or {})
        canonical_bots[str(alias)] = {
            "key": clean_text(raw_bot.get("key")),
            "app_id": clean_text(raw_bot.get("app_id")),
            "skill_types": _sorted_values([clean_text(item) for item in raw_bot.get("skill_types", [])]),
        }

    canonical_users: dict[str, Any] = {}
    for name in sorted(users):
        raw_user = dict(users[name] or {})
        canonical_users[str(name)] = {
            "union_id": clean_text(raw_user.get("union_id")),
            "allow": _sorted_values([clean_text(item) for item in raw_user.get("allow", [])]),
        }

    return {
        "version": int(data.get("version") or 1),
        "bots": canonical_bots,
        "users": canonical_users,
    }


def _atomic_write_yaml(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    canonical = _canonical_data(data)
    text = yaml.safe_dump(canonical, allow_unicode=True, sort_keys=False)
    fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(text)
        os.replace(tmp_name, path)
    finally:
        if os.path.exists(tmp_name):
            os.unlink(tmp_name)


def _load_valid_data(path: Path) -> dict[str, Any]:
    data = load_permission_policy_data(path)
    build_permission_policy(data, path=path)
    return data


def _find_user_name_by_union_id(data: dict[str, Any], union_id: str) -> str:
    users = data.get("users")
    if not isinstance(users, dict):
        return ""
    for name, raw_user in users.items():
        if isinstance(raw_user, dict) and clean_text(raw_user.get("union_id")) == union_id:
            return clean_text(name)
    return ""


def _bot_permission_key(bots: dict[str, Any], alias: str) -> str:
    raw_bot = bots.get(alias)
    if not isinstance(raw_bot, dict):
        return ""
    return clean_text(raw_bot.get("key"))


def _has_allowed_permission_key(bots: dict[str, Any], allow_aliases: list[str], target_key: str) -> bool:
    return any(_bot_permission_key(bots, alias) == target_key for alias in allow_aliases)


def _command_list_bots(args: argparse.Namespace) -> int:
    policy = load_permission_policy(args.policy)
    for alias in sorted(policy.bot_alias_to_key):
        app_id = policy.bot_alias_to_app_id[alias]
        key = policy.bot_alias_to_key[alias]
        skills = ",".join(_sorted_values(list(policy.bot_skill_policy[key])))
        print(f"{alias}\t{app_id}\t{key}\t{skills}")
    return 0


def _command_list_users(args: argparse.Namespace) -> int:
    policy = load_permission_policy(args.policy)
    for name in sorted(policy.user_name_to_union_id):
        union_id = policy.user_name_to_union_id[name]
        allow = ",".join(_sorted_values(list(policy.user_name_to_allow_aliases[name])))
        print(f"{name}\t{union_id}\t{allow}")
    return 0


def _command_show_user(args: argparse.Namespace) -> int:
    union_id = clean_text(args.union_id)
    policy = load_permission_policy(args.policy)
    for name in sorted(policy.user_name_to_union_id):
        if policy.user_name_to_union_id[name] == union_id:
            allow = ",".join(_sorted_values(list(policy.user_name_to_allow_aliases[name])))
            print(f"name: {name}")
            print(f"union_id: {union_id}")
            print(f"allow: {allow}")
            return 0
    print(f"user not found: {union_id}", file=sys.stderr)
    return 1


def _command_grant(args: argparse.Namespace) -> int:
    path = permission_policy_path(args.policy)
    data = _load_valid_data(path)
    users = data.setdefault("users", {})
    bots = data.get("bots", {})

    union_id = clean_text(args.union_id)
    name = clean_text(args.name)
    bot_alias = clean_text(args.bot)
    if not union_id:
        raise PermissionPolicyError("--union-id must not be empty")
    if not name:
        raise PermissionPolicyError("--name must not be empty")
    if bot_alias != ALL and bot_alias not in bots:
        raise PermissionPolicyError(f"unknown bot alias: {bot_alias}")

    existing_name = _find_user_name_by_union_id(data, union_id)
    if existing_name and existing_name != name:
        raise PermissionPolicyError(f"union_id already belongs to user {existing_name}")
    if not existing_name and name in users:
        raise PermissionPolicyError(f"user name already exists with another union_id: {name}")

    user_name = existing_name or name
    user = users.setdefault(user_name, {"union_id": union_id, "allow": []})
    user["union_id"] = union_id
    allow = [clean_text(item) for item in user.get("allow", [])]

    if bot_alias == ALL:
        user["allow"] = [ALL]
    elif ALL not in allow and bot_alias not in allow:
        target_key = _bot_permission_key(bots, bot_alias)
        if not _has_allowed_permission_key(bots, allow, target_key):
            user["allow"] = allow + [bot_alias]

    build_permission_policy(data, path=path)
    _atomic_write_yaml(path, data)
    print(f"granted {bot_alias} to {user_name} ({union_id})")
    return 0


def _command_revoke(args: argparse.Namespace) -> int:
    path = permission_policy_path(args.policy)
    data = _load_valid_data(path)
    users = data.get("users", {})
    bots = data.get("bots", {})

    union_id = clean_text(args.union_id)
    bot_alias = clean_text(args.bot)
    if bot_alias == ALL:
        raise PermissionPolicyError("revoke does not accept '*'; use remove-user to remove all access")
    if bot_alias not in bots:
        raise PermissionPolicyError(f"unknown bot alias: {bot_alias}")

    user_name = _find_user_name_by_union_id(data, union_id)
    if not user_name:
        raise PermissionPolicyError(f"user not found: {union_id}")
    user = users[user_name]
    allow = [clean_text(item) for item in user.get("allow", [])]
    if ALL in allow:
        raise PermissionPolicyError("user has '*' access; revoke cannot remove one concrete bot from '*'")
    target_key = _bot_permission_key(bots, bot_alias)
    remaining = [item for item in allow if _bot_permission_key(bots, item) != target_key]
    if len(remaining) == len(allow):
        print(f"{user_name} ({union_id}) does not have {bot_alias}")
        return 0

    if remaining:
        user["allow"] = remaining
    else:
        del users[user_name]

    build_permission_policy(data, path=path)
    _atomic_write_yaml(path, data)
    print(f"revoked {bot_alias} from {user_name} ({union_id})")
    return 0


def _command_remove_user(args: argparse.Namespace) -> int:
    path = permission_policy_path(args.policy)
    data = _load_valid_data(path)
    users = data.get("users", {})
    union_id = clean_text(args.union_id)
    user_name = _find_user_name_by_union_id(data, union_id)
    if not user_name:
        print(f"user not found: {union_id}", file=sys.stderr)
        return 1
    del users[user_name]
    build_permission_policy(data, path=path)
    _atomic_write_yaml(path, data)
    print(f"removed {user_name} ({union_id})")
    return 0


def _command_validate(args: argparse.Namespace) -> int:
    policy = load_permission_policy(args.policy)
    print(f"valid permission policy: {policy.path}")
    return 0


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Manage Feishu agent permission policy YAML.")
    parser.add_argument("--policy", default=None, help="Path to permission_policy.yaml.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("list-bots").set_defaults(func=_command_list_bots)
    subparsers.add_parser("list-users").set_defaults(func=_command_list_users)

    show_user = subparsers.add_parser("show-user")
    show_user.add_argument("--union-id", required=True)
    show_user.set_defaults(func=_command_show_user)

    grant = subparsers.add_parser("grant")
    grant.add_argument("--union-id", required=True)
    grant.add_argument("--name", required=True)
    grant.add_argument("--bot", required=True)
    grant.set_defaults(func=_command_grant)

    revoke = subparsers.add_parser("revoke")
    revoke.add_argument("--union-id", required=True)
    revoke.add_argument("--bot", required=True)
    revoke.set_defaults(func=_command_revoke)

    remove_user = subparsers.add_parser("remove-user")
    remove_user.add_argument("--union-id", required=True)
    remove_user.set_defaults(func=_command_remove_user)

    subparsers.add_parser("validate").set_defaults(func=_command_validate)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        return int(args.func(args))
    except PermissionPolicyError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
