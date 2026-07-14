from __future__ import annotations

from browser_auth_service import service
from browser_auth_service.service import _remove_dingtalk_storage_state


def test_state_file_uses_lxeskill_database_root(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(service, "repository_root", lambda: tmp_path)

    state_file = service._state_file("account-1")

    assert state_file == (
        tmp_path
        / "var"
        / "db"
        / "lxeskill"
        / "browser_auth_service"
        / "mabang_erp"
        / "account-1"
        / "state.json"
    )
    assert state_file.parent.is_dir()


def test_state_file_copies_legacy_state_without_deleting_source(
    tmp_path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(service, "repository_root", lambda: tmp_path)
    legacy_state_file = (
        tmp_path
        / "browser_auth_service"
        / "auth_data"
        / "mabang_erp"
        / "account-1"
        / "state.json"
    )
    legacy_state_file.parent.mkdir(parents=True)
    legacy_state_file.write_text('{"source": "legacy"}', encoding="utf-8")

    state_file = service._state_file("account-1")

    assert state_file.read_text(encoding="utf-8") == '{"source": "legacy"}'
    assert legacy_state_file.read_text(encoding="utf-8") == '{"source": "legacy"}'


def test_state_file_does_not_overwrite_existing_new_state(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(service, "repository_root", lambda: tmp_path)
    legacy_state_file = (
        tmp_path
        / "browser_auth_service"
        / "auth_data"
        / "mabang_erp"
        / "account-1"
        / "state.json"
    )
    legacy_state_file.parent.mkdir(parents=True)
    legacy_state_file.write_text('{"source": "legacy"}', encoding="utf-8")
    state_file = (
        tmp_path
        / "var"
        / "db"
        / "lxeskill"
        / "browser_auth_service"
        / "mabang_erp"
        / "account-1"
        / "state.json"
    )
    state_file.parent.mkdir(parents=True)
    state_file.write_text('{"source": "current"}', encoding="utf-8")

    resolved_state_file = service._state_file("account-1")

    assert resolved_state_file == state_file
    assert state_file.read_text(encoding="utf-8") == '{"source": "current"}'


def test_remove_dingtalk_storage_state_removes_only_dingtalk_entries() -> None:
    payload = {
        "cookies": [
            {"name": "dt", "value": "1", "domain": ".dingtalk.com", "path": "/"},
            {"name": "dt-login", "value": "2", "domain": "login.dingtalk.com", "path": "/"},
            {"name": "erp", "value": "3", "domain": "private.mabangerp.com", "path": "/"},
            {"name": "fba", "value": "4", "domain": "amz1-private.mabangerp.com", "path": "/"},
            {"name": "other", "value": "5", "domain": "analytics.example.com", "path": "/"},
        ],
        "origins": [
            {
                "origin": "https://login.dingtalk.com",
                "localStorage": [{"name": "APLUS_S_CORE", "value": "large"}],
            },
            {
                "origin": "https://private.mabangerp.com",
                "localStorage": [{"name": "lang", "value": "zh"}],
            },
            {
                "origin": "https://amz1-private.mabangerp.com",
                "localStorage": [{"name": "freeToken", "value": "token"}],
            },
            {
                "origin": "https://analytics.example.com",
                "localStorage": [{"name": "trace", "value": "kept"}],
            },
        ],
    }

    removed = _remove_dingtalk_storage_state(payload)

    assert removed == (2, 1)
    assert [item["domain"] for item in payload["cookies"]] == [
        "private.mabangerp.com",
        "amz1-private.mabangerp.com",
        "analytics.example.com",
    ]
    assert [item["origin"] for item in payload["origins"]] == [
        "https://private.mabangerp.com",
        "https://amz1-private.mabangerp.com",
        "https://analytics.example.com",
    ]


def test_remove_dingtalk_storage_state_handles_missing_lists() -> None:
    payload = {"cookies": "bad", "origins": None, "last_refreshed_at": 123}

    removed = _remove_dingtalk_storage_state(payload)

    assert removed == (0, 0)
    assert payload == {"cookies": "bad", "origins": None, "last_refreshed_at": 123}
