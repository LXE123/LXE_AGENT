from __future__ import annotations

import copy
import json
import time
from pathlib import Path

import pytest

from browser_auth_service import service


def _complete_payload(token: str = "fresh-token") -> dict:
    expires = time.time() + 3600
    cookies = [
        {
            "name": service.PHPSESSID_COOKIE_NAME,
            "value": "fresh-login-session",
            "domain": service.PHPSESSID_HOST,
            "path": "/",
            "expires": expires,
        },
        *[
            {
                "name": name,
                "value": f"fresh-{name}",
                "domain": service.PRIVATE_AMZ_HOST,
                "path": "/",
                "expires": expires,
            }
            for name in service.PRIVATE_AMZ_REQUIRED_COOKIE_NAMES
        ],
    ]
    cookies.append(
        {
            "name": "WMSID",
            "value": "fresh-wms",
            "domain": service.FBA_LOGISTICS_WMS_HOST,
            "path": "/",
            "expires": expires,
        }
    )
    return {
        "cookies": cookies,
        "origins": [
            {
                "origin": service.FBA_LOGISTICS_TOKEN_ORIGIN,
                "localStorage": [
                    {
                        "name": service.FBA_LOGISTICS_TOKEN_LOCAL_STORAGE_KEY,
                        "value": token,
                    }
                ],
            }
        ],
    }


class _FakePage:
    def __init__(self, events: list[str]) -> None:
        self.events = events
        self.url = service.LOGIN_URL

    def goto(self, url: str, wait_until: str = "load") -> None:
        self.url = url
        if url == service.PRIVATE_AMZ_COOKIE_REFRESH_URL:
            self.events.append("inventory")
        elif url == service.FBA_LOGISTICS_TOKEN_TARGET_URL:
            self.events.append("fba")

    def wait_for_load_state(self, state: str, timeout: int) -> None:
        return None

    def wait_for_timeout(self, timeout_ms: int) -> None:
        return None


class _FakeContext:
    def __init__(self, events: list[str], final_payload: dict) -> None:
        self.events = events
        self.final_payload = final_payload
        self.storage_state_calls = 0

    def new_page(self) -> _FakePage:
        return _FakePage(self.events)

    def cookies(self) -> list[dict]:
        return copy.deepcopy(_complete_payload()["cookies"])

    def storage_state(self) -> dict:
        self.storage_state_calls += 1
        self.events.append("storage-state")
        return copy.deepcopy(self.final_payload)

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


def _install_unified_route(
    monkeypatch,
    state_file: Path,
    *,
    final_payload: dict | None = None,
    wms_error: Exception | None = None,
) -> tuple[list[str], _FakeContext, list[dict]]:
    events: list[str] = []
    context = _FakeContext(events, final_payload or _complete_payload())
    context_calls: list[dict] = []

    def fake_open_context(browser, path, can_reuse_state, storage_state_payload=None):
        context_calls.append(
            {
                "can_reuse_state": can_reuse_state,
                "storage_state_payload": storage_state_payload,
                "state_exists": path.exists(),
            }
        )
        return context

    def fake_collect_wms(page, browser_context, host, entry_text):
        events.append("wms")
        if wms_error is not None:
            raise wms_error
        return "WMSID=fresh-wms"

    monkeypatch.setattr(service, "sync_playwright", lambda: _FakePlaywright())
    monkeypatch.setattr(service, "_launch_chromium", lambda playwright, headless: _FakeBrowser())
    monkeypatch.setattr(service, "_open_context", fake_open_context)
    monkeypatch.setattr(service, "_perform_login", lambda page, account, password: events.append("login"))

    def fake_extract_token(page, origin, key):
        events.append("free-token")
        return "fresh-token"

    monkeypatch.setattr(service, "_extract_token", fake_extract_token)
    monkeypatch.setattr(service, "_collect_wms_cookie_header", fake_collect_wms)
    monkeypatch.setattr(service, "_resolve_credentials", lambda scope, account: ("account-a", "password"))
    monkeypatch.setattr(service, "_state_file", lambda account: state_file)
    return events, context, context_calls


@pytest.mark.parametrize(
    ("scope", "require_wms_cookie_header"),
    [
        ("erp", False),
        ("private_amz", False),
        ("fba", False),
        ("fba", True),
    ],
)
def test_every_scope_force_refresh_uses_one_complete_clean_route(
    scope: str,
    require_wms_cookie_header: bool,
    tmp_path: Path,
    monkeypatch,
) -> None:
    state_file = tmp_path / "state.json"
    state_file.write_text(
        '{"cookies":[{"name":"old"}],"last_refreshed_at":1}',
        encoding="utf-8",
    )
    events, context, context_calls = _install_unified_route(monkeypatch, state_file)

    result = service.ensure_auth(
        scope,
        require_wms_cookie_header=require_wms_cookie_header,
        force_refresh=True,
    )

    assert events == ["login", "inventory", "fba", "free-token", "wms", "storage-state"]
    assert context.storage_state_calls == 1
    assert context_calls == [
        {
            "can_reuse_state": False,
            "storage_state_payload": None,
            "state_exists": False,
        }
    ]
    saved_payload = json.loads(state_file.read_text(encoding="utf-8"))
    assert service._require_complete_auth_material(saved_payload)
    assert "last_refreshed_at" not in saved_payload
    assert result["scope"] == scope
    assert result["source"] == "relogin"
    if scope == "fba":
        assert result["free_token"] == "fresh-token"
        assert bool(result["wms_cookie_header"]) is require_wms_cookie_header
    else:
        assert "free_token" not in result
        assert "wms_cookie_header" not in result


@pytest.mark.parametrize("scope", ["erp", "private_amz", "fba"])
def test_complete_state_uses_cache_without_fba_ttl(
    scope: str,
    tmp_path: Path,
    monkeypatch,
) -> None:
    state_file = tmp_path / "state.json"
    payload = _complete_payload("cached-token")
    payload["last_refreshed_at"] = 1
    state_file.write_text(json.dumps(payload), encoding="utf-8")
    monkeypatch.setattr(service, "_resolve_credentials", lambda requested_scope, account: ("account-a", "password"))
    monkeypatch.setattr(service, "_state_file", lambda account: state_file)
    monkeypatch.setattr(
        service,
        "sync_playwright",
        lambda: (_ for _ in ()).throw(AssertionError("complete cache must not open a browser")),
    )

    result = service.ensure_auth(scope, require_wms_cookie_header=True)

    assert result["source"] == "cache"
    if scope == "fba":
        assert result["free_token"] == "cached-token"
        assert "WMSID=fresh-wms" in result["wms_cookie_header"]


@pytest.mark.parametrize("missing", ["private-cookie", "free-token", "wms-cookie"])
def test_missing_any_required_material_runs_complete_refresh(
    missing: str,
    tmp_path: Path,
    monkeypatch,
) -> None:
    state_file = tmp_path / "state.json"
    payload = _complete_payload("cached-token")
    if missing == "private-cookie":
        payload["cookies"] = [
            cookie
            for cookie in payload["cookies"]
            if cookie["name"] != service.PRIVATE_AMZ_REQUIRED_COOKIE_NAMES[-1]
        ]
    elif missing == "free-token":
        payload["origins"] = []
    else:
        payload["cookies"] = [
            cookie
            for cookie in payload["cookies"]
            if not service._is_cookie_domain_match(
                str(cookie.get("domain") or ""),
                service.FBA_LOGISTICS_WMS_HOST,
            )
        ]
    state_file.write_text(json.dumps(payload), encoding="utf-8")
    events, _, _ = _install_unified_route(monkeypatch, state_file)

    result = service.ensure_auth("erp")

    assert result["source"] == "relogin"
    assert events == ["login", "inventory", "fba", "free-token", "wms", "storage-state"]


def test_wms_failure_leaves_no_state_or_partial_write(tmp_path: Path, monkeypatch) -> None:
    state_file = tmp_path / "state.json"
    state_file.write_text('{"cookies":[{"name":"old"}]}', encoding="utf-8")
    events, context, _ = _install_unified_route(
        monkeypatch,
        state_file,
        wms_error=RuntimeError("wms failed"),
    )

    with pytest.raises(RuntimeError, match="wms failed"):
        service.ensure_auth("private_amz", force_refresh=True)

    assert events == ["login", "inventory", "fba", "free-token", "wms"]
    assert context.storage_state_calls == 0
    assert not state_file.exists()


def test_final_state_is_validated_before_atomic_write(tmp_path: Path, monkeypatch) -> None:
    state_file = tmp_path / "state.json"
    state_file.write_text('{"cookies":[{"name":"old"}]}', encoding="utf-8")
    incomplete_payload = _complete_payload()
    incomplete_payload["origins"] = []
    _, context, _ = _install_unified_route(
        monkeypatch,
        state_file,
        final_payload=incomplete_payload,
    )

    with pytest.raises(RuntimeError, match=r"freeToken\(missing\)"):
        service.ensure_auth("fba", force_refresh=True)

    assert context.storage_state_calls == 1
    assert not state_file.exists()


def test_wms_stage_returns_home_and_clicks_entry() -> None:
    events: list[str] = []

    class Entry:
        def filter(self, *, has_text: str):
            return self

        def count(self) -> int:
            return 1

        @property
        def first(self):
            return self

        def click(self, timeout: int, force: bool) -> None:
            events.append("click-wms")

    class Popup:
        url = f"https://{service.FBA_LOGISTICS_WMS_HOST}/redirect/40402/page"

        def wait_for_load_state(self, state: str) -> None:
            events.append("popup-loaded")

        def wait_for_timeout(self, timeout_ms: int) -> None:
            return None

        def close(self) -> None:
            events.append("popup-closed")

    popup = Popup()

    class PopupInfo:
        value = popup

    class PopupExpectation:
        def __enter__(self):
            return PopupInfo()

        def __exit__(self, exc_type, exc, tb) -> None:
            return None

    class Page:
        url = service.FBA_HOME_URL

        def goto(self, url: str, wait_until: str) -> None:
            events.append(f"goto:{url}")
            self.url = url

        def wait_for_timeout(self, timeout_ms: int) -> None:
            return None

        def get_by_role(self, role: str) -> Entry:
            assert role == "listitem"
            return Entry()

        def expect_popup(self, timeout: int) -> PopupExpectation:
            return PopupExpectation()

    class Context:
        def cookies(self, urls=None) -> list[dict]:
            events.append("read-wms-cookies")
            return [
                {
                    "name": "WMSID",
                    "value": "fresh-wms",
                    "domain": service.FBA_LOGISTICS_WMS_HOST,
                }
            ]

    header = service._collect_wms_cookie_header(
        Page(),
        Context(),
        service.FBA_LOGISTICS_WMS_HOST,
        service.FBA_LOGISTICS_WMS_ENTRY_TEXT,
    )

    assert header == "WMSID=fresh-wms"
    assert events == [
        f"goto:{service.FBA_HOME_URL}",
        "click-wms",
        "popup-loaded",
        "read-wms-cookies",
        "popup-closed",
    ]


def test_wms_stage_fails_when_home_has_no_clickable_entry() -> None:
    class EmptyEntry:
        def filter(self, *, has_text: str):
            return self

        def count(self) -> int:
            return 0

    class Page:
        url = service.FBA_HOME_URL

        def goto(self, url: str, wait_until: str) -> None:
            self.url = url

        def wait_for_timeout(self, timeout_ms: int) -> None:
            return None

        def get_by_role(self, role: str) -> EmptyEntry:
            return EmptyEntry()

        def locator(self, selector: str) -> EmptyEntry:
            return EmptyEntry()

    with pytest.raises(RuntimeError, match="未找到 WMS 入口"):
        service._collect_wms_cookie_header(
            Page(),
            object(),
            service.FBA_LOGISTICS_WMS_HOST,
            service.FBA_LOGISTICS_WMS_ENTRY_TEXT,
        )
