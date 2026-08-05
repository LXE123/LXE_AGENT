from __future__ import annotations

import asyncio
import inspect

import pytest

from browser_auth_service.client import BrowserAuthClientError
from services.mabang import auth
from services.mabang.errors import MabangAuthError


def _payload(cookie_value: str = "fresh") -> dict:
    return {
        "success": True,
        "account": "account-a",
        "source": "file",
        "cookies_by_domain": {
            ".mabangerp.com": [
                {"name": "PHPSESSID", "value": cookie_value, "domain": ".mabangerp.com"},
            ]
        },
        "free_token": "free-token",
        "wms_cookie_header": "WMSID=fresh",
    }


def test_public_auth_api_has_only_the_unified_parameters() -> None:
    assert list(inspect.signature(auth.refresh_mabang_auth).parameters) == ["account", "purpose"]
    assert list(inspect.signature(auth.get_auth_context).parameters) == ["account", "purpose"]
    assert list(inspect.signature(auth.get_fba_free_token).parameters) == ["purpose"]
    assert list(inspect.signature(auth.get_fba_wms_cookie_header).parameters) == ["purpose"]
    assert list(auth.MabangAuthContext.__dataclass_fields__) == [
        "account",
        "source",
        "cookies_by_domain",
        "free_token",
        "wms_cookie_header",
    ]


def test_existing_auth_state_is_read_without_refresh(monkeypatch) -> None:
    calls: list[str] = []

    async def fake_read_auth(**kwargs):
        calls.append("read")
        return _payload()

    async def fail_refresh_auth(**kwargs):
        raise AssertionError("existing complete file state must not refresh")

    async def fail_ensure_auth(**kwargs):
        raise AssertionError("existing complete file state must not ensure")

    monkeypatch.setattr(auth, "read_auth", fake_read_auth)
    monkeypatch.setattr(auth, "refresh_auth", fail_refresh_auth)
    monkeypatch.setattr(auth, "ensure_auth", fail_ensure_auth)
    monkeypatch.setattr(auth.mabang_settings, "MABANG_ACCOUNT", "account-a")

    result = asyncio.run(auth.get_auth_context())

    assert result.source == "file"
    assert result.free_token == "free-token"
    assert not hasattr(result, "scope")
    assert not hasattr(result, "raw")
    assert calls == ["read"]


def test_missing_auth_state_ensures_once_then_rereads_file(monkeypatch) -> None:
    calls: list[str] = []
    reads = 0

    async def fake_read_auth(**kwargs):
        nonlocal reads
        reads += 1
        calls.append("read")
        if reads == 1:
            raise BrowserAuthClientError("本地认证状态不存在")
        return _payload("after-refresh")

    async def fake_ensure_auth(**kwargs):
        calls.append("ensure")
        return {"success": True, "state_written": True}

    monkeypatch.setattr(auth, "read_auth", fake_read_auth)
    monkeypatch.setattr(auth, "ensure_auth", fake_ensure_auth)
    monkeypatch.setattr(
        auth,
        "refresh_auth",
        lambda **kwargs: (_ for _ in ()).throw(AssertionError("automatic recovery must not force refresh")),
    )
    monkeypatch.setattr(auth.mabang_settings, "MABANG_ACCOUNT", "account-a")

    result = asyncio.run(auth.get_auth_context())

    assert result.cookies_by_domain[".mabangerp.com"][0]["value"] == "after-refresh"
    assert calls == ["read", "ensure", "read"]


def test_ensure_failure_is_not_retried_and_preserves_real_error(monkeypatch) -> None:
    calls: list[str] = []

    async def missing_read(**kwargs):
        calls.append("read")
        raise BrowserAuthClientError("本地认证状态不存在")

    async def failed_ensure(**kwargs):
        calls.append("ensure")
        raise BrowserAuthClientError(
            "stage=wms current_url=https://private.mabangerp.com/ error=Element is not visible"
        )

    monkeypatch.setattr(auth, "read_auth", missing_read)
    monkeypatch.setattr(auth, "ensure_auth", failed_ensure)
    monkeypatch.setattr(auth.mabang_settings, "MABANG_ACCOUNT", "account-a")

    with pytest.raises(MabangAuthError) as captured:
        asyncio.run(auth.get_auth_context())

    assert calls == ["read", "ensure"]
    assert "stage=wms" in str(captured.value)
    assert "Element is not visible" in str(captured.value)


def test_explicit_refresh_always_calls_real_refresh_once(monkeypatch) -> None:
    calls: list[dict] = []

    async def fake_refresh_auth(**kwargs):
        calls.append(kwargs)
        return {"success": True, "source": "refresh", "state_written": True}

    async def fail_ensure_auth(**kwargs):
        raise AssertionError("explicit refresh must not use coalesced ensure")

    monkeypatch.setattr(auth, "refresh_auth", fake_refresh_auth)
    monkeypatch.setattr(auth, "ensure_auth", fail_ensure_auth)
    monkeypatch.setattr(auth.mabang_settings, "MABANG_ACCOUNT", "account-a")

    result = asyncio.run(auth.refresh_mabang_auth(purpose="manual"))

    assert result["source"] == "refresh"
    assert calls == [{"account": "account-a"}]
