from __future__ import annotations

import asyncio

from browser_auth_service.client import BrowserAuthClientError
from services.mabang import auth


def _payload(cookie_value: str = "fresh") -> dict:
    return {
        "success": True,
        "scope": "erp",
        "account": "account-a",
        "source": "file",
        "cookies_by_domain": {
            ".mabangerp.com": [
                {"name": "PHPSESSID", "value": cookie_value, "domain": ".mabangerp.com"},
            ]
        },
    }


def test_existing_auth_state_is_read_without_refresh(monkeypatch) -> None:
    calls: list[str] = []

    async def fake_read_auth(**kwargs):
        calls.append("read")
        return _payload()

    async def fail_ensure_auth(**kwargs):
        raise AssertionError("existing file state must not refresh")

    monkeypatch.setattr(auth, "read_auth", fake_read_auth)
    monkeypatch.setattr(auth, "ensure_auth", fail_ensure_auth)
    monkeypatch.setattr(auth.mabang_settings, "MABANG_ACCOUNT", "account-a")

    result = asyncio.run(auth.ensure_mabang_auth_payload(scope="erp"))

    assert result["source"] == "file"
    assert calls == ["read"]


def test_missing_auth_state_refreshes_then_rereads_file(monkeypatch) -> None:
    calls: list[str] = []
    reads = 0

    async def fake_read_auth(**kwargs):
        nonlocal reads
        reads += 1
        calls.append("read")
        if reads == 1:
            raise BrowserAuthClientError("本地认证状态不存在")
        return _payload()

    async def fake_ensure_auth(**kwargs):
        calls.append("ensure")
        assert kwargs["force_refresh"] is False
        return {"success": True}

    monkeypatch.setattr(auth, "read_auth", fake_read_auth)
    monkeypatch.setattr(auth, "ensure_auth", fake_ensure_auth)
    monkeypatch.setattr(auth.mabang_settings, "MABANG_ACCOUNT", "account-a")

    result = asyncio.run(auth.ensure_mabang_auth_payload(scope="erp"))

    assert result["source"] == "file"
    assert calls == ["read", "ensure", "read"]


def test_force_refresh_always_refreshes_then_rereads_file(monkeypatch) -> None:
    calls: list[str] = []

    async def fake_ensure_auth(**kwargs):
        calls.append("ensure")
        assert kwargs["force_refresh"] is True
        return {"success": True}

    async def fake_read_auth(**kwargs):
        calls.append("read")
        return _payload("after-refresh")

    monkeypatch.setattr(auth, "read_auth", fake_read_auth)
    monkeypatch.setattr(auth, "ensure_auth", fake_ensure_auth)
    monkeypatch.setattr(auth.mabang_settings, "MABANG_ACCOUNT", "account-a")

    result = asyncio.run(auth.ensure_mabang_auth_payload(scope="erp", force_refresh=True))

    assert result["cookies_by_domain"][".mabangerp.com"][0]["value"] == "after-refresh"
    assert calls == ["ensure", "read"]
