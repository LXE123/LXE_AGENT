from __future__ import annotations

import json
import time
from contextlib import contextmanager
from pathlib import Path

import pytest

from browser_auth_service import service


def _fba_payload(token: str = "token") -> dict:
    return {
        "cookies": [
            {
                "name": "PHPSESSID",
                "value": token,
                "domain": ".mabangerp.com",
                "path": "/",
            }
        ],
        "origins": [
            {
                "origin": service.FBA_LOGISTICS_TOKEN_ORIGIN,
                "localStorage": [
                    {"name": service.FBA_LOGISTICS_TOKEN_LOCAL_STORAGE_KEY, "value": token},
                ],
            }
        ],
        "last_refreshed_at": int(time.time()),
    }


def test_ensure_auth_locks_next_to_account_state_and_reloads_after_lock(tmp_path, monkeypatch) -> None:
    state_file = tmp_path / "account-a" / "state.json"
    state_file.parent.mkdir(parents=True)
    state_file.write_text(json.dumps(_fba_payload()), encoding="utf-8")
    lock_paths: list[Path] = []
    seen_payloads: list[dict] = []

    @contextmanager
    def fake_lock(path, *, timeout_seconds):
        lock_paths.append(Path(path))
        fresh = _fba_payload()
        fresh["last_refreshed_at"] = 222
        state_file.write_text(json.dumps(fresh), encoding="utf-8")
        yield

    def fake_ensure(**kwargs):
        seen_payloads.append(kwargs["payload"])
        return {"success": True, "scope": "fba", "account": "account-a", "source": "cache"}

    monkeypatch.setattr(service, "_resolve_credentials", lambda scope, account: ("account-a", "password"))
    monkeypatch.setattr(service, "_state_file", lambda account: state_file)
    monkeypatch.setattr(service, "interprocess_lock", fake_lock)
    monkeypatch.setattr(service, "_ensure_fba_auth", fake_ensure)

    result = service.ensure_auth("fba")

    assert result["source"] == "cache"
    assert lock_paths == [state_file.with_name(service.AUTH_REFRESH_LOCK_NAME)]
    assert seen_payloads[0]["last_refreshed_at"] == 222


def test_consecutive_forced_refreshes_are_never_coalesced(tmp_path, monkeypatch) -> None:
    state_file = tmp_path / "state.json"
    calls: list[bool] = []

    def fake_ensure(**kwargs):
        calls.append(kwargs["force_refresh"])
        return {"success": True, "scope": "fba", "account": "account-a", "source": "cache"}

    monkeypatch.setattr(service, "_resolve_credentials", lambda scope, account: ("account-a", "password"))
    monkeypatch.setattr(service, "_state_file", lambda account: state_file)
    monkeypatch.setattr(service, "_ensure_fba_auth", fake_ensure)

    state_file.write_text(json.dumps(_fba_payload()), encoding="utf-8")
    service.ensure_auth("fba", force_refresh=True)

    state_file.write_text(json.dumps(_fba_payload()), encoding="utf-8")
    service.ensure_auth("fba", force_refresh=True)

    assert calls == [True, True]


def test_read_auth_reloads_state_after_account_lock(tmp_path, monkeypatch) -> None:
    state_file = tmp_path / "account-a" / "state.json"
    state_file.parent.mkdir(parents=True)
    state_file.write_text(json.dumps(_fba_payload("token-a")), encoding="utf-8")
    lock_paths: list[Path] = []

    @contextmanager
    def fake_lock(path, *, timeout_seconds):
        lock_paths.append(Path(path))
        state_file.write_text(json.dumps(_fba_payload("token-b")), encoding="utf-8")
        yield

    monkeypatch.setattr(service, "_state_file", lambda account: state_file)
    monkeypatch.setattr(service, "interprocess_lock", fake_lock)
    monkeypatch.setattr(service.mabang_settings, "MABANG_ACCOUNT", "account-a")

    result = service.read_auth("fba")

    assert result["source"] == "file"
    assert result["free_token"] == "token-b"
    assert lock_paths == [state_file.with_name(service.AUTH_REFRESH_LOCK_NAME)]


def test_read_auth_does_not_cache_file_payload(tmp_path, monkeypatch) -> None:
    state_file = tmp_path / "account-a" / "state.json"
    state_file.parent.mkdir(parents=True)
    monkeypatch.setattr(service, "_state_file", lambda account: state_file)
    monkeypatch.setattr(service.mabang_settings, "MABANG_ACCOUNT", "account-a")

    state_file.write_text(json.dumps(_fba_payload("token-a")), encoding="utf-8")
    first = service.read_auth("fba")
    state_file.write_text(json.dumps(_fba_payload("token-b")), encoding="utf-8")
    second = service.read_auth("fba")

    assert first["free_token"] == "token-a"
    assert second["free_token"] == "token-b"
    assert first["cookies_by_domain"]["mabangerp.com"][0]["value"] == "token-a"
    assert second["cookies_by_domain"]["mabangerp.com"][0]["value"] == "token-b"


def test_save_storage_state_atomically_replaces_file(tmp_path) -> None:
    state_file = tmp_path / "state.json"
    state_file.write_text(json.dumps({"cookies": [{"name": "old"}]}), encoding="utf-8")

    class FakeContext:
        def storage_state(self):
            return {"cookies": [{"name": "new", "domain": "example.com", "path": "/"}], "origins": []}

    payload = service._save_storage_state(
        FakeContext(),
        state_file,
        extra_fields={"last_refreshed_at": 2},
    )

    saved = json.loads(state_file.read_text(encoding="utf-8"))
    assert saved == payload
    assert saved["cookies"][0]["name"] == "new"
    assert saved["last_refreshed_at"] == 2
    assert list(tmp_path.glob(".state.json.*.tmp")) == []


def test_atomic_write_failure_preserves_previous_state(tmp_path, monkeypatch) -> None:
    state_file = tmp_path / "state.json"
    state_file.write_text('{"stable":true}', encoding="utf-8")
    monkeypatch.setattr(service.os, "replace", lambda source, target: (_ for _ in ()).throw(OSError("disk full")))

    with pytest.raises(OSError, match="disk full"):
        service._write_storage_state_payload(state_file, {"stable": False})

    assert state_file.read_text(encoding="utf-8") == '{"stable":true}'
    assert list(tmp_path.glob(".state.json.*.tmp")) == []
