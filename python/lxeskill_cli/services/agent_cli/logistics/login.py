"""Ask Desktop to use its encrypted credentials, without returning them to CLI."""
from __future__ import annotations

import json
import os
from urllib.parse import urlsplit

import requests

from .common import diagnostic, safe_output
from .profiles import selected_profile


def ensure_login(profile: dict, revision: int, store_id: str) -> dict:
    session_id = os.environ.get("LXE_AGENT_SESSION_ID", "").strip()
    if not session_id:
        raise ValueError("LXE_AGENT_SESSION_ID is required; run in the LXE_Agent execution session")
    endpoint = os.environ.get("LXE_LOGISTICS_LOGIN_HOST_URL", "")
    token = os.environ.get("LXE_LOGISTICS_LOGIN_HOST_TOKEN", "")
    url = urlsplit(endpoint)
    if (url.scheme != "http" or url.hostname != "127.0.0.1" or not url.port
            or url.username or url.password or url.path or url.query or url.fragment or not token):
        raise ValueError("Desktop logistics login host is unavailable; restart the Desktop built from this branch")
    with requests.Session() as session:
        session.trust_env = False
        with session.post(endpoint + "/v1/logistics/login", json={"profile_id": profile["profile_id"],
                          "store_id": store_id, "session_id": session_id, "expected_revision": revision},
                          headers={"Authorization": "Bearer " + token}, timeout=(5, 95),
                          allow_redirects=False, stream=True) as response:
            chunks, size = [], 0
            for chunk in response.iter_content(chunk_size=8192):
                size += len(chunk)
                if size > 65536:
                    raise ValueError("Desktop login response exceeds 64 KiB [truncated]")
                chunks.append(chunk)
            body = b"".join(chunks).decode("utf-8")
            try:
                result = json.loads(body)
            except ValueError as exc:
                raise ValueError(f"Desktop login HTTP {response.status_code}: {diagnostic(body)}; {exc}") from exc
            if not isinstance(result, dict) or type(result.get("success")) is not bool:
                raise ValueError(f"Desktop login HTTP {response.status_code}: invalid result {diagnostic(result)}")
            if not 200 <= response.status_code < 300 and result["success"]:
                raise ValueError(f"Desktop login returned success with HTTP {response.status_code}")
            return safe_output(result)


def run(arguments):
    try:
        if not isinstance(arguments, dict) or set(arguments) - {"profile_id", "store_id"}:
            raise ValueError("Only profile_id and store_id are accepted")
        profile, revision = selected_profile(arguments.get("profile_id"))
        if profile["provider_id"] == "jiufang":
            raise ValueError("Jiufang public queries do not require login")
        store = arguments.get("store_id")
        if not isinstance(store, str) or not store.strip() or len(store) > 256:
            raise ValueError("store_id is required for browser login")
        result = ensure_login(profile, revision, store)
        return {**result, "profile_id": profile["profile_id"], "provider": profile["provider_id"],
                "settings_revision": revision, "auth_refresh_required": False}
    except Exception as exc:
        return {"success": False, "auth_refresh_required": False,
                "error": {"code": "logistics_login_failed", "message": diagnostic(f"{type(exc).__name__}: {exc}")}}
