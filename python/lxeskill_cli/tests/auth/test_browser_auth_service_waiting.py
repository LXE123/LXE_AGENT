from __future__ import annotations

import json
from contextlib import contextmanager
from types import SimpleNamespace

import pytest

from browser_auth_service import service
from test_browser_auth_service_clean_refresh import _complete_payload, _install_refresh_route


class Clock:
    now = 0.0

    def monotonic(self):
        return self.now


class Page:
    def __init__(self, clock, *, redirect_at=0, cookies_at=0, response_body=None, response_delay=0):
        self.clock = clock
        self.redirect_at = redirect_at
        self.cookies_at = cookies_at
        self.response_delay = response_delay
        self.response_body = response_body if response_body is not None else '{"success":true}'
        self.context = self
        self.destination = service.FBA_HOME_URL
        self.current_url = service.LOGIN_URL
        self.clicked = False
        self.form_present = False
        self.waits = []
        self.cookie_payload = _complete_payload()["cookies"]
        self.cookie_payload.append({
            "name": service.MABANG_MEMCACHE_COOKIE_NAME, "value": "member-session",
            "domain": service.PHPSESSID_HOST, "path": "/", "expires": -1,
        })

    @property
    def url(self):
        if self.clicked and self.clock.now >= self.redirect_at:
            return self.destination
        return self.current_url

    def goto(self, url, *, wait_until):
        assert wait_until == "domcontentloaded"
        self.current_url = url

    def get_by_role(self, role, *, name):
        return SimpleNamespace(fill=lambda value: None)

    def locator(self, selector):
        return SimpleNamespace(
            click=self.click,
            count=lambda: int(self.form_present),
        )

    def click(self, *, timeout):
        assert timeout == 40000
        assert not self.clicked, "login must only submit once"
        self.clicked = True

    @contextmanager
    def expect_response(self, predicate, *, timeout):
        assert timeout == 40000
        response = SimpleNamespace(
            url=f"https://{service.PHPSESSID_HOST}/index.php?mod=main.doLogin&lang=cn",
            request=SimpleNamespace(method="POST"), status=200,
            text=self.read_response,
        )
        assert predicate(response)
        assert not predicate(SimpleNamespace(
            url="https://other.example/index.php?mod=main.doLogin", request=response.request,
        ))
        yield SimpleNamespace(value=response)
        self.clock.now += self.response_delay

    def read_response(self):
        if isinstance(self.response_body, Exception):
            raise self.response_body
        return self.response_body

    def cookies(self):
        return self.cookie_payload if self.clock.now >= self.cookies_at else []

    def wait_for_timeout(self, timeout_ms):
        self.waits.append(timeout_ms)
        self.clock.now += timeout_ms / 1000


@pytest.fixture
def clock(monkeypatch):
    clock = Clock()
    monkeypatch.setattr(service.time, "monotonic", clock.monotonic)
    return clock


def test_login_ready_immediately_has_no_fixed_wait(clock):
    page = Page(clock)
    service._perform_login(page, "account", "password")
    assert page.clicked
    assert page.waits == []


def test_login_waits_for_redirect_and_session_cookie(clock):
    page = Page(clock, redirect_at=0.5, cookies_at=1)
    service._perform_login(page, "account", "password")
    assert clock.now == 1
    assert page.waits == [250] * 4


@pytest.mark.parametrize("condition", ["login_url", "login_form", "foreign_host", "empty_session"])
def test_login_does_not_accept_initial_or_incomplete_session(clock, condition):
    page = Page(clock)
    if condition == "login_url":
        page.redirect_at = 100
    elif condition == "login_form":
        page.form_present = True
    elif condition == "foreign_host":
        page.destination = "https://private.mabangerp.com.other.example/"
    else:
        for cookie in page.cookie_payload:
            if cookie["name"] == "PHPSESSID":
                cookie["value"] = ""
    with pytest.raises(service.PlaywrightTimeoutError, match="认证状态超时"):
        service._perform_login(page, "account", "password")
    assert clock.now == 40


def test_login_response_time_uses_the_same_40_second_deadline(clock):
    page = Page(clock, cookies_at=100, response_delay=39)
    with pytest.raises(service.PlaywrightTimeoutError, match="PHPSESSID"):
        service._perform_login(page, "account", "password")
    assert clock.now == 40
    assert page.waits == [250] * 4


@pytest.mark.parametrize("payload", [
    {"success": False, "message": "账号或密码错误"},
    {"success": False, "errCode": "CHECK_VERIFY_CODE", "message": "请完成验证码"},
    {"success": False, "errCode": 2001, "message": "需要短信验证"},
])
def test_failed_login_preserves_response_and_does_not_retry(clock, payload):
    page = Page(clock, response_body=json.dumps(payload, ensure_ascii=False))
    with pytest.raises(RuntimeError, match=payload["message"]) as captured:
        service._perform_login(page, "account", "password")
    if "errCode" in payload:
        assert str(payload["errCode"]) in str(captured.value)
    assert page.clicked
    assert page.waits == []


def test_login_preserves_malformed_response(clock):
    page = Page(clock, response_body="upstream temporarily unavailable")
    with pytest.raises(RuntimeError, match="upstream temporarily unavailable") as captured:
        service._perform_login(page, "account", "password")
    assert isinstance(captured.value.__cause__, json.JSONDecodeError)


@pytest.mark.parametrize("member_cookie", [True, False])
def test_retired_login_response_requires_member_cookie_and_keeps_actual_error(clock, caplog, member_cookie):
    message = "Response.text: Protocol error (Network.getResponseBody): No resource with given identifier found"
    page = Page(clock, response_body=service.PlaywrightError(message))
    if member_cookie:
        service._perform_login(page, "account", "password")
        assert page.waits == []
    else:
        page.cookie_payload = [c for c in page.cookie_payload if c["name"] != service.MABANG_MEMCACHE_COOKIE_NAME]
        with pytest.raises(service.PlaywrightTimeoutError, match=service.MABANG_MEMCACHE_COOKIE_NAME):
            service._perform_login(page, "account", "password")
    assert message in caplog.text


def test_unrelated_response_body_error_is_not_suppressed(clock):
    message = "Response.text: Target page, context or browser has been closed"
    page = Page(clock, response_body=service.PlaywrightError(message))
    with pytest.raises(service.PlaywrightError, match="Target page"):
        service._perform_login(page, "account", "password")
    assert page.waits == []


@pytest.mark.parametrize("ready_at", [0, 0.75])
def test_inventory_continues_as_soon_as_required_cookies_exist(clock, ready_at):
    page = Page(clock, cookies_at=ready_at)
    service._visit_private_amz_cookie_refresh_page(page)
    assert clock.now == ready_at
    assert sum(page.waits) == ready_at * 1000


def test_inventory_timeout_reports_missing_cookies(clock):
    page = Page(clock)
    page.cookie_payload = [cookie for cookie in page.cookie_payload if cookie["name"] != "signed"]
    with pytest.raises(service.PlaywrightTimeoutError, match="private-amz:signed"):
        service._visit_private_amz_cookie_refresh_page(page)
    assert clock.now == 12
    assert page.waits == [250] * 48


def test_inventory_preserves_actual_browser_error(clock):
    page = Page(clock)
    def fail(*args, **kwargs):
        raise service.PlaywrightTimeoutError("Page.goto: net::ERR_CONNECTION_RESET")
    page.goto = fail
    with pytest.raises(service.PlaywrightTimeoutError, match="net::ERR_CONNECTION_RESET"):
        service._visit_private_amz_cookie_refresh_page(page)
    assert page.waits == []


@pytest.mark.parametrize("fails", [False, True])
def test_stage_and_total_timing_cover_success_and_failure(tmp_path, monkeypatch, caplog, clock, fails):
    caplog.set_level("INFO")
    _install_refresh_route(monkeypatch, tmp_path / "state.json")
    def login(*args):
        clock.now += 0.75
        if fails:
            raise service.PlaywrightTimeoutError("actual login timeout")
    monkeypatch.setattr(service, "_perform_login", login)
    if fails:
        with pytest.raises(service.BrowserAuthRefreshError, match="actual login timeout"):
            service.refresh_auth()
    else:
        service.refresh_auth()
    status = "failed" if fails else "success"
    assert f"stage=login status={status} elapsed_ms=750" in caplog.text
    assert f"stage=refresh status={status} elapsed_ms=750" in caplog.text
    if not fails:
        for stage in ("inventory_sku", "fba_delivery", "wms", "persist"):
            assert f"stage={stage} status=success elapsed_ms=" in caplog.text


def test_failure_diagnostics_redact_secrets_and_keep_actual_error(monkeypatch, caplog, clock):
    caplog.set_level("INFO")
    monkeypatch.setattr(service.mabang_settings, "MABANG_PASSWORD", "test p@ssword")
    monkeypatch.setattr(service.mabang_settings, "MABANG_ACCOUNT", "test-account")
    url = "https://private.mabangerp.com/index.php?mod=main.plogin&ticket=secret-ticket#secret-fragment"
    cause = RuntimeError('actual upstream error; password="test p@ssword" freeToken="secret-token" ' + url)
    error = service._refresh_error(stage="login", current_url=url, cause=cause, started_at=0)
    output = caplog.text + json.dumps(error.to_payload())
    assert "actual upstream error" in output
    assert "mod=main.plogin" in output
    for secret in ("test p@ssword", "secret-token", "secret-ticket", "secret-fragment"):
        assert secret not in output
    assert "[REDACTED]" in output
    assert "[truncated " in service._diagnostic("failure detail " * 500)


def test_response_diagnostic_redacts_nested_auth_material():
    payload = {
        "success": False, "message": "actual rejection", "data": {
            "cookies": [{"name": "session", "value": "secret-cookie"}],
            "authorization": "Bearer secret-bearer",
            "mobile": "12345678901",
        },
    }
    result = service._diagnostic(json.dumps(payload))
    assert "actual rejection" in result
    for secret in ("secret-cookie", "secret-bearer", "12345678901"):
        assert secret not in result
