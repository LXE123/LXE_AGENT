from __future__ import annotations

from browser_auth_service.service import _remove_dingtalk_storage_state


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
