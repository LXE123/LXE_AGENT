from __future__ import annotations

import json
from types import SimpleNamespace

from clients.auth import browser_auth_client


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
