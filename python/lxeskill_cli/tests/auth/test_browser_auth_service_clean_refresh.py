from __future__ import annotations

import time
from pathlib import Path

import pytest

from browser_auth_service import service


class _FakePage:
    url = "https://private.mabangerp.com/"

    def goto(self, url: str, wait_until: str = "load") -> None:
        self.url = url

    def wait_for_load_state(self, state: str, timeout: int) -> None:
        return None

    def wait_for_timeout(self, timeout_ms: int) -> None:
        return None


class _FakeContext:
    def new_page(self) -> _FakePage:
        return _FakePage()

    def close(self) -> None:
        return None


class _FakePlaywright:
    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        return None


class _FakeBrowser:
    def close(self) -> None:
        return None


@pytest.mark.parametrize("scope", ["erp", "private_amz"])
def test_cookie_scope_force_refresh_uses_clean_context(scope: str, tmp_path: Path, monkeypatch) -> None:
    state_file = tmp_path / "state.json"
    state_file.write_text('{"cookies":[{"name":"old"}]}', encoding="utf-8")
    context_calls: list[dict] = []
    login_calls: list[tuple[str, str]] = []

    def fake_open_context(browser, path, can_reuse_state, storage_state_payload=None):
        context_calls.append(
            {
                "can_reuse_state": can_reuse_state,
                "storage_state_payload": storage_state_payload,
                "state_exists": path.exists(),
            }
        )
        return _FakeContext()

    def fake_save_storage_state(context, path, extra_fields=None):
        return {
            "cookies": [
                {
                    "name": name,
                    "value": "fresh",
                    "domain": service.PRIVATE_AMZ_HOST,
                    "path": "/",
                    "expires": time.time() + 3600,
                }
                for name in service.PRIVATE_AMZ_REQUIRED_COOKIE_NAMES
            ],
            "origins": [],
        }

    monkeypatch.setattr(service, "sync_playwright", lambda: _FakePlaywright())
    monkeypatch.setattr(service, "_launch_chromium", lambda playwright, headless: _FakeBrowser())
    monkeypatch.setattr(service, "_open_context", fake_open_context)
    monkeypatch.setattr(service, "_perform_login", lambda page, account, password: login_calls.append((account, password)))
    monkeypatch.setattr(service, "_save_storage_state", fake_save_storage_state)

    kwargs = {
        "account": "account-a",
        "password": "password",
        "state_file": state_file,
        "payload": {"cookies": [{"name": "old"}]},
        "phpsessid_status": {"valid": True},
        "force_refresh": True,
    }
    if scope == "erp":
        result = service._ensure_erp_auth(**kwargs)
    else:
        result = service._ensure_private_amz_auth(**kwargs)

    assert result["source"] == "relogin"
    assert context_calls == [
        {
            "can_reuse_state": False,
            "storage_state_payload": None,
            "state_exists": False,
        }
    ]
    assert login_calls == [("account-a", "password")]


def test_failed_refresh_does_not_restore_old_state(tmp_path: Path, monkeypatch) -> None:
    state_file = tmp_path / "state.json"
    state_file.write_text('{"cookies":[{"name":"old","value":"cookie"}]}', encoding="utf-8")

    monkeypatch.setattr(service, "sync_playwright", lambda: _FakePlaywright())
    monkeypatch.setattr(service, "_launch_chromium", lambda playwright, headless: _FakeBrowser())
    monkeypatch.setattr(service, "_open_context", lambda *args, **kwargs: _FakeContext())
    monkeypatch.setattr(
        service,
        "_perform_login",
        lambda page, account, password: (_ for _ in ()).throw(RuntimeError("login failed")),
    )

    with pytest.raises(RuntimeError, match="login failed"):
        service._ensure_erp_auth(
            account="account-a",
            password="password",
            state_file=state_file,
            payload={"cookies": [{"name": "old", "value": "cookie"}]},
            phpsessid_status={"valid": False},
            force_refresh=True,
        )

    assert not state_file.exists()
