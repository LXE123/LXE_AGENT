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
        {
            "name": "WMSID",
            "value": "fresh-wms",
            "domain": service.FBA_LOGISTICS_WMS_HOST,
            "path": "/",
            "expires": expires,
        },
    ]
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
        self.events.append("context-close")


class _FakePlaywright:
    def __init__(self, events: list[str]) -> None:
        self.events = events

    def __enter__(self):
        self.events.append("playwright-enter")
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.events.append("playwright-exit")
        return None


class _FakeBrowser:
    def __init__(self, context: _FakeContext, context_calls: list[dict], state_file: Path) -> None:
        self.context = context
        self.context_calls = context_calls
        self.state_file = state_file

    def new_context(self, **kwargs):
        self.context_calls.append({**kwargs, "state_exists": self.state_file.exists()})
        return self.context

    def close(self) -> None:
        self.context.events.append("browser-close")


def _install_refresh_route(
    monkeypatch,
    state_file: Path,
    *,
    final_payload: dict | None = None,
    wms_error: Exception | None = None,
) -> tuple[list[str], _FakeContext, list[dict]]:
    events: list[str] = []
    context = _FakeContext(events, final_payload or _complete_payload())
    context_calls: list[dict] = []

    def fake_collect_wms(page, browser_context, host, entry_text):
        events.append("wms")
        if wms_error is not None:
            raise wms_error
        return "WMSID=fresh-wms", f"https://{service.FBA_LOGISTICS_WMS_HOST}/redirect/40402/page"

    monkeypatch.setattr(service, "sync_playwright", lambda: _FakePlaywright(events))
    monkeypatch.setattr(
        service,
        "_launch_chromium",
        lambda playwright, headless: _FakeBrowser(context, context_calls, state_file),
    )
    monkeypatch.setattr(service, "_perform_login", lambda page, account, password: events.append("login"))

    def fake_extract_token(page, origin, key):
        events.append("free-token")
        return "fresh-token"

    monkeypatch.setattr(service, "_extract_token", fake_extract_token)
    monkeypatch.setattr(service, "_collect_wms_cookie_header", fake_collect_wms)
    monkeypatch.setattr(service, "_resolve_credentials", lambda account: ("account-a", "password"))
    monkeypatch.setattr(service, "_state_file", lambda account: state_file)
    return events, context, context_calls


def test_refresh_always_runs_one_complete_clean_route(tmp_path: Path, monkeypatch, caplog) -> None:
    caplog.set_level("INFO")
    state_file = tmp_path / "state.json"
    state_file.write_text(json.dumps(_complete_payload("old-token")), encoding="utf-8")
    events, context, context_calls = _install_refresh_route(monkeypatch, state_file)

    result = service.refresh_auth()

    assert events == [
        "playwright-enter",
        "login",
        "inventory",
        "fba",
        "free-token",
        "wms",
        "storage-state",
        "context-close",
        "browser-close",
        "playwright-exit",
    ]
    assert context.storage_state_calls == 1
    assert context_calls == [
        {
            "accept_downloads": True,
            "viewport": {"width": 1920, "height": 1080},
            "state_exists": False,
        }
    ]
    assert "storage_state" not in context_calls[0]
    saved_payload = json.loads(state_file.read_text(encoding="utf-8"))
    assert service._require_complete_auth_material(saved_payload)
    assert result == {
        "success": True,
        "account": "account-a",
        "source": "refresh",
        "final_url": f"https://{service.FBA_LOGISTICS_WMS_HOST}/redirect/40402/page",
        "state_written": True,
    }
    assert "scope" not in result
    assert "free_token" not in result
    assert "wms_cookie_header" not in result
    for stage in ("credentials", "browser", "login", "inventory_sku", "fba_delivery", "wms", "persist"):
        assert f"stage={stage} status=start" in caplog.text
        assert f"stage={stage} status=success" in caplog.text


def test_consecutive_refreshes_both_run_complete_route(tmp_path: Path, monkeypatch) -> None:
    state_file = tmp_path / "state.json"
    events, context, context_calls = _install_refresh_route(monkeypatch, state_file)

    service.refresh_auth()
    service.refresh_auth()

    one_route = [
        "playwright-enter",
        "login",
        "inventory",
        "fba",
        "free-token",
        "wms",
        "storage-state",
        "context-close",
        "browser-close",
        "playwright-exit",
    ]
    assert events == one_route * 2
    assert context.storage_state_calls == 2
    assert len(context_calls) == 2


def test_read_auth_returns_all_complete_material_without_browser(tmp_path: Path, monkeypatch) -> None:
    state_file = tmp_path / "state.json"
    state_file.write_text(json.dumps(_complete_payload("cached-token")), encoding="utf-8")
    monkeypatch.setattr(service, "_state_file", lambda account: state_file)
    monkeypatch.setattr(service.mabang_settings, "MABANG_ACCOUNT", "account-a")
    monkeypatch.setattr(
        service,
        "sync_playwright",
        lambda: (_ for _ in ()).throw(AssertionError("file read must not open a browser")),
    )

    result = service.read_auth()

    assert result["source"] == "file"
    assert result["free_token"] == "cached-token"
    assert "WMSID=fresh-wms" in result["wms_cookie_header"]
    assert result["cookies_by_domain"]
    assert "scope" not in result


@pytest.mark.parametrize("missing", ["private-cookie", "free-token", "wms-cookie"])
def test_read_auth_rejects_any_incomplete_material(missing: str, tmp_path: Path, monkeypatch) -> None:
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
    monkeypatch.setattr(service, "_state_file", lambda account: state_file)
    monkeypatch.setattr(service.mabang_settings, "MABANG_ACCOUNT", "account-a")

    with pytest.raises(RuntimeError, match="统一认证状态不完整"):
        service.read_auth()


def test_read_auth_preserves_invalid_state_file_error(tmp_path: Path, monkeypatch) -> None:
    state_file = tmp_path / "state.json"
    state_file.write_text("{not-json", encoding="utf-8")
    monkeypatch.setattr(service, "_state_file", lambda account: state_file)
    monkeypatch.setattr(service.mabang_settings, "MABANG_ACCOUNT", "account-a")

    with pytest.raises(RuntimeError) as captured:
        service.read_auth()

    assert "JSONDecodeError" in str(captured.value)
    assert "Expecting property name" in str(captured.value)


def test_wms_failure_reports_stage_and_leaves_no_state(tmp_path: Path, monkeypatch) -> None:
    state_file = tmp_path / "state.json"
    state_file.write_text(json.dumps(_complete_payload("old-token")), encoding="utf-8")
    events, context, _ = _install_refresh_route(
        monkeypatch,
        state_file,
        wms_error=RuntimeError("element is not visible"),
    )

    with pytest.raises(service.BrowserAuthRefreshError) as captured:
        service.refresh_auth()

    assert captured.value.stage == "wms"
    assert captured.value.current_url == service.FBA_LOGISTICS_TOKEN_TARGET_URL
    assert captured.value.exception_type == "RuntimeError"
    assert str(captured.value) == "element is not visible"
    assert events == [
        "playwright-enter",
        "login",
        "inventory",
        "fba",
        "free-token",
        "wms",
        "context-close",
        "browser-close",
        "playwright-exit",
    ]
    assert context.storage_state_calls == 0
    assert not state_file.exists()


def test_final_state_is_validated_before_atomic_write(tmp_path: Path, monkeypatch) -> None:
    state_file = tmp_path / "state.json"
    state_file.write_text(json.dumps(_complete_payload("old-token")), encoding="utf-8")
    incomplete_payload = _complete_payload()
    incomplete_payload["origins"] = []
    _, context, _ = _install_refresh_route(
        monkeypatch,
        state_file,
        final_payload=incomplete_payload,
    )

    with pytest.raises(service.BrowserAuthRefreshError) as captured:
        service.refresh_auth()

    assert captured.value.stage == "persist"
    assert "freeToken(missing)" in str(captured.value)
    assert context.storage_state_calls == 1
    assert not state_file.exists()


def test_credentials_failure_is_structured(monkeypatch) -> None:
    monkeypatch.setattr(
        service,
        "_resolve_credentials",
        lambda account: (_ for _ in ()).throw(ValueError("Mabang 密码为空")),
    )

    with pytest.raises(service.BrowserAuthRefreshError) as captured:
        service.refresh_auth()

    assert captured.value.to_payload() == {
        "success": False,
        "stage": "credentials",
        "current_url": "",
        "exception_type": "ValueError",
        "message": "Mabang 密码为空",
    }


def test_refresh_closes_browser_resources_before_playwright_exit(tmp_path: Path, monkeypatch) -> None:
    state_file = tmp_path / "state.json"
    events, _, _ = _install_refresh_route(monkeypatch, state_file)

    service.refresh_auth()

    assert events[-3:] == ["context-close", "browser-close", "playwright-exit"]


def test_wms_stage_navigates_hidden_entry_href_without_clicking() -> None:
    events: list[str] = []
    jump_href = "/index.php?mod=main.jumpToWms"
    jump_url = f"https://private.mabangerp.com{jump_href}"
    final_url = f"https://{service.FBA_LOGISTICS_WMS_HOST}/redirect/40402/page"

    class Entry:
        @property
        def first(self):
            return self

        def wait_for(self, *, state: str, timeout: int) -> None:
            assert state == "attached"
            assert timeout == 10000
            events.append("wait-wms-entry")

        def get_attribute(self, name: str) -> str:
            assert name == "href"
            events.append("read-wms-href")
            return jump_href

        def click(self, *args, **kwargs) -> None:
            raise AssertionError("hidden WMS entry must not be clicked")

    class Page:
        url = service.FBA_HOME_URL

        def goto(self, url: str, wait_until: str) -> None:
            assert wait_until == "domcontentloaded"
            events.append(f"goto:{url}")
            self.url = final_url if url == jump_url else url

        def wait_for_timeout(self, timeout_ms: int) -> None:
            return None

        def locator(self, selector: str) -> Entry:
            assert selector == "a[href*='main.jumpToWms']"
            return Entry()

        def expect_popup(self, *args, **kwargs):
            raise AssertionError("direct navigation must not wait for a popup")

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

    header, final_url = service._collect_wms_cookie_header(
        Page(),
        Context(),
        service.FBA_LOGISTICS_WMS_HOST,
        service.FBA_LOGISTICS_WMS_ENTRY_TEXT,
    )

    assert header == "WMSID=fresh-wms"
    assert final_url == f"https://{service.FBA_LOGISTICS_WMS_HOST}/redirect/40402/page"
    assert events == [
        f"goto:{service.FBA_HOME_URL}",
        "wait-wms-entry",
        "read-wms-href",
        f"goto:{jump_url}",
        "read-wms-cookies",
    ]


def test_wms_stage_reports_missing_entry_after_wait_timeout() -> None:
    selected_selector = ""

    class EmptyEntry:
        @property
        def first(self):
            return self

        def wait_for(self, *, state: str, timeout: int) -> None:
            raise service.PlaywrightTimeoutError("waiting for WMS entry timed out")

    class Page:
        url = service.FBA_HOME_URL

        def goto(self, url: str, wait_until: str) -> None:
            self.url = url

        def wait_for_timeout(self, timeout_ms: int) -> None:
            return None

        def locator(self, selector: str) -> EmptyEntry:
            nonlocal selected_selector
            selected_selector = selector
            return EmptyEntry()

    with pytest.raises(service.BrowserAuthRefreshError) as captured:
        service._collect_wms_cookie_header(
            Page(),
            object(),
            service.FBA_LOGISTICS_WMS_HOST,
            service.FBA_LOGISTICS_WMS_ENTRY_TEXT,
        )

    assert captured.value.to_payload()["stage"] == "wms"
    assert captured.value.to_payload()["current_url"] == service.FBA_HOME_URL
    assert captured.value.to_payload()["exception_type"] == "RuntimeError"
    assert str(captured.value) == f"FBA 首页未找到 WMS 入口: {service.FBA_LOGISTICS_WMS_ENTRY_TEXT}"
    assert selected_selector == "a[href*='main.jumpToWms']"


def test_wms_stage_reports_entry_without_href() -> None:
    class Entry:
        @property
        def first(self):
            return self

        def wait_for(self, *, state: str, timeout: int) -> None:
            return None

        def get_attribute(self, name: str) -> None:
            return None

    class Page:
        url = service.FBA_HOME_URL

        def goto(self, url: str, wait_until: str) -> None:
            self.url = url

        def locator(self, selector: str) -> Entry:
            return Entry()

    with pytest.raises(service.BrowserAuthRefreshError) as captured:
        service._collect_wms_cookie_header(
            Page(),
            object(),
            service.FBA_LOGISTICS_WMS_HOST,
            service.FBA_LOGISTICS_WMS_ENTRY_TEXT,
        )

    assert captured.value.to_payload() == {
        "success": False,
        "stage": "wms",
        "current_url": service.FBA_HOME_URL,
        "exception_type": "RuntimeError",
        "message": f"FBA 首页 WMS 入口缺少 href: {service.FBA_LOGISTICS_WMS_ENTRY_TEXT}",
    }


def test_wms_stage_preserves_direct_navigation_error() -> None:
    class FakePlaywrightError(Exception):
        pass

    class Entry:
        @property
        def first(self):
            return self

        def wait_for(self, *, state: str, timeout: int) -> None:
            return None

        def get_attribute(self, name: str) -> str:
            return "/index.php?mod=main.jumpToWms"

    class Page:
        url = service.FBA_HOME_URL

        def goto(self, url: str, wait_until: str) -> None:
            if url == service.FBA_HOME_URL:
                self.url = url
                return
            raise FakePlaywrightError("Page.goto: net::ERR_CONNECTION_RESET")

        def locator(self, selector: str) -> Entry:
            return Entry()

    with pytest.raises(service.BrowserAuthRefreshError) as captured:
        service._collect_wms_cookie_header(
            Page(),
            object(),
            service.FBA_LOGISTICS_WMS_HOST,
            service.FBA_LOGISTICS_WMS_ENTRY_TEXT,
        )

    assert captured.value.to_payload() == {
        "success": False,
        "stage": "wms",
        "current_url": service.FBA_HOME_URL,
        "exception_type": "FakePlaywrightError",
        "message": "Page.goto: net::ERR_CONNECTION_RESET",
    }


def test_wms_stage_reports_redirect_timeout(monkeypatch) -> None:
    jump_url = "https://private.mabangerp.com/index.php?mod=main.jumpToWms"

    class Entry:
        @property
        def first(self):
            return self

        def wait_for(self, *, state: str, timeout: int) -> None:
            return None

        def get_attribute(self, name: str) -> str:
            return "/index.php?mod=main.jumpToWms"

    class Page:
        url = service.FBA_HOME_URL

        def goto(self, url: str, wait_until: str) -> None:
            self.url = url

        def locator(self, selector: str) -> Entry:
            return Entry()

        def wait_for_timeout(self, timeout_ms: int) -> None:
            return None

    clock = iter([100.0, 131.0])
    monkeypatch.setattr(service.time, "monotonic", lambda: next(clock))

    with pytest.raises(service.BrowserAuthRefreshError) as captured:
        service._collect_wms_cookie_header(
            Page(),
            object(),
            service.FBA_LOGISTICS_WMS_HOST,
            service.FBA_LOGISTICS_WMS_ENTRY_TEXT,
        )

    assert captured.value.to_payload() == {
        "success": False,
        "stage": "wms",
        "current_url": jump_url,
        "exception_type": "RuntimeError",
        "message": f"WMS 跳转超时，当前URL: {jump_url}",
    }
