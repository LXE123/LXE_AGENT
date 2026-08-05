from __future__ import annotations

import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from pathlib import Path

import pytest

from browser_auth_service import service


def _complete_payload(token: str = "token") -> dict:
    expires = time.time() + 3600
    return {
        "cookies": [
            {
                "name": service.PHPSESSID_COOKIE_NAME,
                "value": token,
                "domain": service.PHPSESSID_HOST,
                "path": "/",
                "expires": expires,
            },
            *[
                {
                    "name": name,
                    "value": token,
                    "domain": service.PRIVATE_AMZ_HOST,
                    "path": "/",
                    "expires": expires,
                }
                for name in service.PRIVATE_AMZ_REQUIRED_COOKIE_NAMES
            ],
            {
                "name": "WMSID",
                "value": token,
                "domain": service.FBA_LOGISTICS_WMS_HOST,
                "path": "/",
                "expires": expires,
            },
        ],
        "origins": [
            {
                "origin": service.FBA_LOGISTICS_TOKEN_ORIGIN,
                "localStorage": [
                    {"name": service.FBA_LOGISTICS_TOKEN_LOCAL_STORAGE_KEY, "value": token},
                ],
            }
        ],
    }


def test_refresh_auth_locks_next_to_account_state(tmp_path, monkeypatch) -> None:
    state_file = tmp_path / "account-a" / "state.json"
    state_file.parent.mkdir(parents=True)
    lock_paths: list[Path] = []
    calls: list[dict] = []

    @contextmanager
    def fake_lock(path, *, timeout_seconds):
        lock_paths.append(Path(path))
        yield

    def fake_refresh(**kwargs):
        calls.append(kwargs)
        return {
            "success": True,
            "account": "account-a",
            "source": "refresh",
            "final_url": "https://wms.private.mabangerp.com/",
            "state_written": True,
        }

    monkeypatch.setattr(service, "_resolve_credentials", lambda account: ("account-a", "password"))
    monkeypatch.setattr(service, "_state_file", lambda account: state_file)
    monkeypatch.setattr(service, "interprocess_lock", fake_lock)
    monkeypatch.setattr(service, "_refresh_auth", fake_refresh)

    result = service.refresh_auth()

    assert result["source"] == "refresh"
    assert lock_paths == [state_file.with_name(service.AUTH_REFRESH_LOCK_NAME)]
    assert calls == [
        {
            "account": "account-a",
            "password": "password",
            "state_file": state_file,
        }
    ]


def test_consecutive_refreshes_are_never_coalesced(tmp_path, monkeypatch) -> None:
    state_file = tmp_path / "state.json"
    calls = 0

    def fake_refresh(**kwargs):
        nonlocal calls
        calls += 1
        return {"success": True, "source": "refresh"}

    monkeypatch.setattr(service, "_resolve_credentials", lambda account: ("account-a", "password"))
    monkeypatch.setattr(service, "_state_file", lambda account: state_file)
    monkeypatch.setattr(service, "_refresh_auth", fake_refresh)

    service.refresh_auth()
    service.refresh_auth()

    assert calls == 2


def test_consecutive_ensure_calls_refresh_once_then_coalesce(tmp_path, monkeypatch) -> None:
    state_file = tmp_path / "account-a" / "state.json"
    state_file.parent.mkdir(parents=True)
    refresh_calls = 0
    password_calls = 0

    def fake_password() -> str:
        nonlocal password_calls
        password_calls += 1
        return "password"

    def fake_refresh(**kwargs):
        nonlocal refresh_calls
        refresh_calls += 1
        state_file.write_text(json.dumps(_complete_payload("fresh")), encoding="utf-8")
        return {
            "success": True,
            "account": "account-a",
            "source": "refresh",
            "final_url": "https://wms.private.mabangerp.com/",
            "state_written": True,
        }

    monkeypatch.setattr(service, "_resolve_account", lambda account: "account-a")
    monkeypatch.setattr(service, "_resolve_password", fake_password)
    monkeypatch.setattr(service, "_state_file", lambda account: state_file)
    monkeypatch.setattr(service, "_refresh_auth", fake_refresh)

    results = [service.ensure_auth() for _ in range(3)]

    assert [result["source"] for result in results] == ["refresh", "coalesced", "coalesced"]
    assert [result["state_written"] for result in results] == [True, False, False]
    assert refresh_calls == 1
    assert password_calls == 1


def test_three_concurrent_ensure_calls_start_one_refresh(tmp_path, monkeypatch) -> None:
    state_file = tmp_path / "account-a" / "state.json"
    state_file.parent.mkdir(parents=True)
    callers_ready = threading.Barrier(3)
    refresh_call_lock = threading.Lock()
    refresh_calls = 0

    def fake_refresh(**kwargs):
        nonlocal refresh_calls
        with refresh_call_lock:
            refresh_calls += 1
        time.sleep(0.05)
        state_file.write_text(json.dumps(_complete_payload("concurrent")), encoding="utf-8")
        return {
            "success": True,
            "account": "account-a",
            "source": "refresh",
            "final_url": "https://wms.private.mabangerp.com/",
            "state_written": True,
        }

    def call_ensure() -> dict:
        callers_ready.wait()
        return service.ensure_auth()

    monkeypatch.setattr(service, "_resolve_account", lambda account: "account-a")
    monkeypatch.setattr(service, "_resolve_password", lambda: "password")
    monkeypatch.setattr(service, "_state_file", lambda account: state_file)
    monkeypatch.setattr(service, "_refresh_auth", fake_refresh)

    with ThreadPoolExecutor(max_workers=3) as executor:
        results = list(executor.map(lambda _: call_ensure(), range(3)))

    assert sorted(result["source"] for result in results) == ["coalesced", "coalesced", "refresh"]
    assert refresh_calls == 1


def test_ensure_auth_reloads_complete_state_after_lock(tmp_path, monkeypatch) -> None:
    state_file = tmp_path / "account-a" / "state.json"
    state_file.parent.mkdir(parents=True)
    lock_paths: list[Path] = []

    @contextmanager
    def fake_lock(path, *, timeout_seconds):
        lock_paths.append(Path(path))
        state_file.write_text(json.dumps(_complete_payload("written-by-other")), encoding="utf-8")
        yield

    monkeypatch.setattr(service, "_resolve_account", lambda account: "account-a")
    monkeypatch.setattr(service, "_state_file", lambda account: state_file)
    monkeypatch.setattr(service, "interprocess_lock", fake_lock)
    monkeypatch.setattr(
        service,
        "_resolve_password",
        lambda: (_ for _ in ()).throw(AssertionError("coalesced ensure must not resolve password")),
    )
    monkeypatch.setattr(
        service,
        "_refresh_auth",
        lambda **kwargs: (_ for _ in ()).throw(AssertionError("coalesced ensure must not refresh")),
    )

    result = service.ensure_auth()

    assert result == {
        "success": True,
        "account": "account-a",
        "source": "coalesced",
        "final_url": "",
        "state_written": False,
    }
    assert lock_paths == [state_file.with_name(service.AUTH_REFRESH_LOCK_NAME)]


def test_ensure_auth_next_waiter_retries_after_refresh_failure(tmp_path, monkeypatch) -> None:
    state_file = tmp_path / "account-a" / "state.json"
    state_file.parent.mkdir(parents=True)
    refresh_calls = 0

    def fake_refresh(**kwargs):
        nonlocal refresh_calls
        refresh_calls += 1
        if refresh_calls == 1:
            raise service.BrowserAuthRefreshError(
                stage="login",
                current_url=service.LOGIN_URL,
                cause=RuntimeError("temporary login failure"),
            )
        state_file.write_text(json.dumps(_complete_payload("recovered")), encoding="utf-8")
        return {
            "success": True,
            "account": "account-a",
            "source": "refresh",
            "final_url": "https://wms.private.mabangerp.com/",
            "state_written": True,
        }

    monkeypatch.setattr(service, "_resolve_account", lambda account: "account-a")
    monkeypatch.setattr(service, "_resolve_password", lambda: "password")
    monkeypatch.setattr(service, "_state_file", lambda account: state_file)
    monkeypatch.setattr(service, "_refresh_auth", fake_refresh)

    with pytest.raises(service.BrowserAuthRefreshError, match="temporary login failure"):
        service.ensure_auth()
    result = service.ensure_auth()

    assert result["source"] == "refresh"
    assert refresh_calls == 2


def test_read_auth_reloads_state_after_account_lock(tmp_path, monkeypatch) -> None:
    state_file = tmp_path / "account-a" / "state.json"
    state_file.parent.mkdir(parents=True)
    state_file.write_text(json.dumps(_complete_payload("token-a")), encoding="utf-8")
    lock_paths: list[Path] = []

    @contextmanager
    def fake_lock(path, *, timeout_seconds):
        lock_paths.append(Path(path))
        state_file.write_text(json.dumps(_complete_payload("token-b")), encoding="utf-8")
        yield

    monkeypatch.setattr(service, "_state_file", lambda account: state_file)
    monkeypatch.setattr(service, "interprocess_lock", fake_lock)
    monkeypatch.setattr(service.mabang_settings, "MABANG_ACCOUNT", "account-a")

    result = service.read_auth()

    assert result["source"] == "file"
    assert result["free_token"] == "token-b"
    assert lock_paths == [state_file.with_name(service.AUTH_REFRESH_LOCK_NAME)]


def test_read_auth_does_not_cache_file_payload(tmp_path, monkeypatch) -> None:
    state_file = tmp_path / "account-a" / "state.json"
    state_file.parent.mkdir(parents=True)
    monkeypatch.setattr(service, "_state_file", lambda account: state_file)
    monkeypatch.setattr(service.mabang_settings, "MABANG_ACCOUNT", "account-a")

    state_file.write_text(json.dumps(_complete_payload("token-a")), encoding="utf-8")
    first = service.read_auth()
    state_file.write_text(json.dumps(_complete_payload("token-b")), encoding="utf-8")
    second = service.read_auth()

    assert first["free_token"] == "token-a"
    assert second["free_token"] == "token-b"


def test_save_storage_state_atomically_replaces_file_without_old_metadata(tmp_path) -> None:
    state_file = tmp_path / "state.json"
    state_file.write_text(json.dumps({"cookies": [{"name": "old"}], "generation": 1}), encoding="utf-8")

    class FakeContext:
        def storage_state(self):
            return {"cookies": [{"name": "new", "domain": "example.com", "path": "/"}], "origins": []}

    payload = service._save_storage_state(FakeContext(), state_file)

    saved = json.loads(state_file.read_text(encoding="utf-8"))
    assert saved == payload
    assert saved["cookies"][0]["name"] == "new"
    assert "generation" not in saved
    assert list(tmp_path.glob(".state.json.*.tmp")) == []


def test_atomic_write_failure_preserves_previous_state(tmp_path, monkeypatch) -> None:
    state_file = tmp_path / "state.json"
    state_file.write_text('{"stable":true}', encoding="utf-8")
    monkeypatch.setattr(service.os, "replace", lambda source, target: (_ for _ in ()).throw(OSError("disk full")))

    with pytest.raises(OSError, match="disk full"):
        service._write_storage_state_payload(state_file, {"stable": False})

    assert state_file.read_text(encoding="utf-8") == '{"stable":true}'
    assert list(tmp_path.glob(".state.json.*.tmp")) == []
