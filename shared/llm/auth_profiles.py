from __future__ import annotations

import json
import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

from shared.env import load_project_env


load_project_env()


_AUTH_PROFILE_PATH = Path(__file__).resolve().parent / "auth_profiles.json"


@dataclass(frozen=True, slots=True)
class AuthProfile:
    provider: str
    type: str
    env_names: tuple[str, ...]
    required: bool


def _clean_text(value: Any) -> str:
    return str(value or "").strip()


def _load_json(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise RuntimeError(f"Invalid LLM auth profile JSON: {path}") from exc
    if not isinstance(payload, dict):
        raise RuntimeError(f"LLM auth profile JSON must be an object: {path}")
    return payload


def _parse_auth_profile(provider_name: str, payload: Any, *, path: Path) -> AuthProfile:
    provider = _clean_text(provider_name)
    if not isinstance(payload, dict):
        raise RuntimeError(f"LLM auth profile must be an object for provider {provider}: {path}")
    auth_type = _clean_text(payload.get("type"))
    env_names_raw = payload.get("env_names")
    if not provider:
        raise RuntimeError(f"LLM auth profile missing provider: {path}")
    if auth_type != "api_key":
        raise RuntimeError(f"Unsupported LLM auth profile type for {provider}: {auth_type}")
    if not isinstance(env_names_raw, list):
        raise RuntimeError(f"LLM auth profile env_names must be a list: {path}")
    env_names = tuple(_clean_text(item) for item in env_names_raw if _clean_text(item))
    if not env_names:
        raise RuntimeError(f"LLM auth profile must define at least one env var: {path}")
    return AuthProfile(
        provider=provider,
        type=auth_type,
        env_names=env_names,
        required=bool(payload.get("required", True)),
    )


@lru_cache(maxsize=1)
def load_auth_profiles() -> dict[str, AuthProfile]:
    payload = _load_json(_AUTH_PROFILE_PATH)
    profiles_raw = payload.get("profiles")
    if not isinstance(profiles_raw, dict):
        raise RuntimeError(f"LLM auth profiles JSON must define object field profiles: {_AUTH_PROFILE_PATH}")
    profiles: dict[str, AuthProfile] = {}
    for provider_name, profile_payload in sorted(profiles_raw.items()):
        profile = _parse_auth_profile(provider_name, profile_payload, path=_AUTH_PROFILE_PATH)
        if profile.provider in profiles:
            raise RuntimeError(f"Duplicate LLM auth profile provider: {profile.provider}")
        profiles[profile.provider] = profile
    if not profiles:
        raise RuntimeError(f"LLM auth profiles JSON must define at least one provider: {_AUTH_PROFILE_PATH}")
    return profiles


def auth_profile_for_provider(provider_name: str) -> AuthProfile:
    provider = _clean_text(provider_name)
    profiles = load_auth_profiles()
    try:
        return profiles[provider]
    except KeyError as exc:
        raise ValueError(f"Unsupported LLM auth provider: {provider_name}") from exc


def api_key_for_provider(provider_name: str) -> str:
    profile = auth_profile_for_provider(provider_name)
    for env_name in profile.env_names:
        value = _clean_text(os.getenv(env_name, ""))
        if value:
            return value
    return ""


__all__ = [
    "AuthProfile",
    "api_key_for_provider",
    "auth_profile_for_provider",
    "load_auth_profiles",
]
