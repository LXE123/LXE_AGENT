from __future__ import annotations

import json
from types import SimpleNamespace

from browser_auth_service import client as browser_auth_client
from browser_auth_service import service as browser_auth_service


def test_ensure_auth_sync_passes_force_refresh_to_cli(monkeypatch) -> None:
    calls: list[list[str]] = []

    def fake_run(command: list[str], **kwargs):
        calls.append(command)
        payload = {"success": True, "scope": "fba", "source": "refresh"}
        return SimpleNamespace(
            returncode=0,
            stdout=json.dumps(payload).encode("utf-8"),
            stderr=b"",
        )

    monkeypatch.setattr(browser_auth_client.subprocess, "run", fake_run)

    result = browser_auth_client.ensure_auth_sync("fba", force_refresh=True)

    assert result["success"] is True
    assert calls
    assert "--force-refresh" in calls[0]


def test_read_auth_sync_uses_direct_file_reader(monkeypatch) -> None:
    calls: list[dict] = []

    def fake_read_auth(**kwargs):
        calls.append(kwargs)
        return {"success": True, "scope": "fba", "source": "file", "free_token": "fresh"}

    monkeypatch.setattr(browser_auth_service, "read_auth", fake_read_auth)

    result = browser_auth_client.read_auth_sync("fba", require_wms_cookie_header=True)

    assert result["source"] == "file"
    assert calls == [
        {
            "scope": "fba",
            "account": "",
            "require_wms_cookie_header": True,
        }
    ]
