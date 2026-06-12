from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml


ALL = "*"
POLICY_PATH_ENV = "LXE_PERMISSION_POLICY_PATH"
DEFAULT_PERMISSION_POLICY_PATH = Path(__file__).resolve().parents[1] / "config" / "permission_policy.yaml"


class PermissionPolicyError(ValueError):
    pass


class _UniqueKeyLoader(yaml.SafeLoader):
    pass


def _construct_unique_mapping(loader: yaml.SafeLoader, node: yaml.MappingNode, deep: bool = False) -> dict[Any, Any]:
    loader.flatten_mapping(node)
    mapping: dict[Any, Any] = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        if key in mapping:
            raise PermissionPolicyError(f"duplicate YAML key: {key!r}")
        mapping[key] = loader.construct_object(value_node, deep=deep)
    return mapping


_UniqueKeyLoader.add_constructor(
    yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG,
    _construct_unique_mapping,
)


@dataclass(frozen=True)
class PermissionPolicy:
    path: Path
    bot_id_to_key: dict[str, str]
    bot_alias_to_key: dict[str, str]
    bot_alias_to_app_id: dict[str, str]
    bot_skill_policy: dict[str, set[str]]
    user_agent_policy: dict[str, set[str]]
    user_name_to_union_id: dict[str, str]
    user_name_to_allow_aliases: dict[str, set[str]]


def clean_text(value: Any) -> str:
    return str(value or "").strip()


def permission_policy_path(path: str | Path | None = None) -> Path:
    if path is not None:
        return Path(path).expanduser()
    configured = clean_text(os.getenv(POLICY_PATH_ENV))
    if configured:
        return Path(configured).expanduser()
    return DEFAULT_PERMISSION_POLICY_PATH


def load_permission_policy_data(path: str | Path | None = None) -> dict[str, Any]:
    safe_path = permission_policy_path(path)
    if not safe_path.exists():
        raise PermissionPolicyError(f"permission policy file not found: {safe_path}")
    try:
        parsed = yaml.load(safe_path.read_text(encoding="utf-8"), Loader=_UniqueKeyLoader)
    except PermissionPolicyError:
        raise
    except yaml.YAMLError as exc:
        raise PermissionPolicyError(f"invalid permission policy YAML: {safe_path}: {exc}") from exc
    except OSError as exc:
        raise PermissionPolicyError(f"cannot read permission policy file: {safe_path}: {exc}") from exc
    if not isinstance(parsed, dict):
        raise PermissionPolicyError(f"permission policy root must be a mapping: {safe_path}")
    return parsed


def _require_mapping(value: Any, context: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise PermissionPolicyError(f"{context} must be a mapping")
    return value


def _string_list(value: Any, context: str) -> list[str]:
    if not isinstance(value, list):
        raise PermissionPolicyError(f"{context} must be a list")
    items: list[str] = []
    seen: set[str] = set()
    for item in value:
        safe_item = clean_text(item)
        if not safe_item:
            raise PermissionPolicyError(f"{context} contains an empty value")
        if safe_item in seen:
            raise PermissionPolicyError(f"{context} contains duplicate value: {safe_item}")
        seen.add(safe_item)
        items.append(safe_item)
    return items


def build_permission_policy(data: dict[str, Any], *, path: str | Path | None = None) -> PermissionPolicy:
    safe_path = permission_policy_path(path)
    root = _require_mapping(data, "permission policy root")
    bots_raw = _require_mapping(root.get("bots"), "bots")
    users_raw = _require_mapping(root.get("users"), "users")
    if not bots_raw:
        raise PermissionPolicyError("bots must not be empty")

    bot_id_to_key: dict[str, str] = {}
    bot_alias_to_key: dict[str, str] = {}
    bot_alias_to_app_id: dict[str, str] = {}
    bot_skill_policy: dict[str, set[str]] = {}
    seen_bot_keys: set[str] = set()

    for raw_alias, raw_bot in bots_raw.items():
        alias = clean_text(raw_alias)
        if not alias:
            raise PermissionPolicyError("bot alias must not be empty")
        bot_data = _require_mapping(raw_bot, f"bot {alias}")
        key = clean_text(bot_data.get("key"))
        app_id = clean_text(bot_data.get("app_id"))
        skill_types = _string_list(bot_data.get("skill_types"), f"bot {alias}.skill_types")
        if not key:
            raise PermissionPolicyError(f"bot {alias}.key must not be empty")
        if not app_id:
            raise PermissionPolicyError(f"bot {alias}.app_id must not be empty")
        if not skill_types:
            raise PermissionPolicyError(f"bot {alias}.skill_types must not be empty")
        if key in seen_bot_keys:
            raise PermissionPolicyError(f"duplicate bot permission key: {key}")
        if app_id in bot_id_to_key:
            raise PermissionPolicyError(f"duplicate bot app_id: {app_id}")
        seen_bot_keys.add(key)
        bot_id_to_key[app_id] = key
        bot_alias_to_key[alias] = key
        bot_alias_to_app_id[alias] = app_id
        bot_skill_policy[key] = set(skill_types)

    user_agent_policy: dict[str, set[str]] = {}
    user_name_to_union_id: dict[str, str] = {}
    user_name_to_allow_aliases: dict[str, set[str]] = {}

    for raw_name, raw_user in users_raw.items():
        name = clean_text(raw_name)
        if not name:
            raise PermissionPolicyError("user name must not be empty")
        user_data = _require_mapping(raw_user, f"user {name}")
        union_id = clean_text(user_data.get("union_id"))
        allow_aliases = _string_list(user_data.get("allow"), f"user {name}.allow")
        if not union_id:
            raise PermissionPolicyError(f"user {name}.union_id must not be empty")
        if not allow_aliases:
            raise PermissionPolicyError(f"user {name}.allow must not be empty")
        if union_id in user_agent_policy:
            raise PermissionPolicyError(f"duplicate user union_id: {union_id}")
        if ALL in allow_aliases and len(allow_aliases) > 1:
            raise PermissionPolicyError(f"user {name}.allow cannot mix {ALL!r} with bot aliases")

        allowed_keys: set[str] = set()
        for alias in allow_aliases:
            if alias == ALL:
                allowed_keys.add(ALL)
                continue
            bot_key = bot_alias_to_key.get(alias)
            if not bot_key:
                raise PermissionPolicyError(f"user {name}.allow references unknown bot alias: {alias}")
            allowed_keys.add(bot_key)

        user_agent_policy[union_id] = allowed_keys
        user_name_to_union_id[name] = union_id
        user_name_to_allow_aliases[name] = set(allow_aliases)

    return PermissionPolicy(
        path=safe_path,
        bot_id_to_key=bot_id_to_key,
        bot_alias_to_key=bot_alias_to_key,
        bot_alias_to_app_id=bot_alias_to_app_id,
        bot_skill_policy=bot_skill_policy,
        user_agent_policy=user_agent_policy,
        user_name_to_union_id=user_name_to_union_id,
        user_name_to_allow_aliases=user_name_to_allow_aliases,
    )


def load_permission_policy(path: str | Path | None = None) -> PermissionPolicy:
    safe_path = permission_policy_path(path)
    return build_permission_policy(load_permission_policy_data(safe_path), path=safe_path)


__all__ = [
    "ALL",
    "DEFAULT_PERMISSION_POLICY_PATH",
    "POLICY_PATH_ENV",
    "PermissionPolicy",
    "PermissionPolicyError",
    "build_permission_policy",
    "clean_text",
    "load_permission_policy",
    "load_permission_policy_data",
    "permission_policy_path",
]
