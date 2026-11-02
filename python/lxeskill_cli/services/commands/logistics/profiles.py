"""Model-visible account selection; never expose encrypted credential references."""
from __future__ import annotations

import os

from .common import diagnostic, safe_output
from .provider_registry import PROVIDER_BY_ID
from .settings import profile_id, read_snapshot


def require_provider_scope(provider: str) -> None:
    owner = "jiufang-logistics-query" if provider == "jiufang" else "fba-logistics-query"
    scope = os.environ.get("LXESKILL_SKILL_SCOPE")
    if scope is not None and owner not in {part.strip() for part in scope.split(",")}:
        raise ValueError(f"Provider {provider} requires skill {owner} in the execution scope")


def selected_profile(identifier: object) -> tuple[dict, int]:
    identifier = profile_id(identifier)
    snapshot = read_snapshot()
    profile = next((item for item in snapshot["profiles"] if item["profile_id"] == identifier), None)
    if profile is None:
        raise ValueError("Logistics profile does not exist; reload profiles")
    require_provider_scope(profile["provider_id"])
    if not profile["enabled"]:
        raise ValueError("Logistics profile is disabled")
    return profile, snapshot["revision"]


def run(arguments):
    try:
        if not isinstance(arguments, dict) or set(arguments) - {"provider"}:
            raise ValueError("Only provider is accepted")
        provider = arguments.get("provider")
        if provider is not None:
            if not isinstance(provider, str) or provider not in PROVIDER_BY_ID:
                raise ValueError("Unknown logistics provider")
            require_provider_scope(provider)
        snapshot = read_snapshot()
        profiles = []
        for item in snapshot["profiles"]:
            if provider is not None and item["provider_id"] != provider:
                continue
            try:
                require_provider_scope(item["provider_id"])
            except ValueError:
                continue
            profiles.append({key: item[key] for key in
                ("profile_id", "display_name", "provider_id", "enabled", "login_username")})
        return safe_output({"success": True, "revision": snapshot["revision"], "profiles": profiles})
    except Exception as exc:
        return {"success": False, "auth_refresh_required": False,
                "error": {"code": "profiles_failed", "message": diagnostic(f"{type(exc).__name__}: {exc}")}}
