"""Synthetic live-form scenarios, not a captured vendor login contract."""
from contextlib import contextmanager
import io
import json
import shutil
import subprocess
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from selenium.common.exceptions import TimeoutException

from services.agent_cli.logistics import login_worker as worker

REQUEST = {"provider_id": "wesa", "store_id": "test-store", "login_username": "fixture-user", "password": 'fixture-"password"'}
ORIGIN = "http://wsaexp.nextsls.com"


def form(**changes):
    return {"password_count": 1, "form_present": True, "user_count": 1, "submit_count": 1,
        "challenge_count": 0, "authenticated": False, "company_names": [], "errors": "",
        "form_action": ORIGIN + "/login", "submit_action": None,
        "username": Mock(), "password": Mock(), "submit": Mock(), **changes}


def fake_driver(monkeypatch, probes):
    calls = []
    driver = SimpleNamespace(current_url=ORIGIN + "/wos", switch_to=SimpleNamespace(default_content=lambda: None))
    def probe(script):
        assert script == worker.FORM_SCRIPT
        calls.append("probe")
        result = probes.pop(0) if len(probes) > 1 else probes[0]
        if isinstance(result, Exception):
            raise result
        return result
    driver.execute_script = probe
    @contextmanager
    def attach(store_id, **kwargs):
        calls.append((store_id, kwargs))
        yield SimpleNamespace(), driver
    monkeypatch.setattr(worker, "store_driver_session", attach)
    monkeypatch.setenv("LXE_AGENT_SESSION_ID", "lxe-test")
    class Wait:
        def __init__(self, *args, **kwargs):
            pass
        def until(self, callback):
            if not callback(driver):
                raise TimeoutException("fixture wait expired")
    monkeypatch.setattr(worker, "WebDriverWait", Wait)
    return driver, calls


def test_single_native_submission_verifies_post_login_and_exports_no_credentials(monkeypatch):
    initial = form()
    final = {"authenticated": True, "password_count": 0, "company_names": ["测试有限公司"]}
    driver, calls = fake_driver(monkeypatch, [initial, initial, final])
    result = worker.run_private(REQUEST)
    assert result["success"] is True and result["authenticated"] is True
    assert result["configured_login_submitted"] is True
    assert not result["profile_identity_verified"]
    assert result["login_attempted"]
    assert result["status"] == "authenticated"
    assert calls[0] == ("test-store", {"strict_attach": True, "target_host": "wsaexp.nextsls.com"})
    initial["username"].send_keys.assert_called_once_with("fixture-user")
    initial["password"].send_keys.assert_called_once_with(REQUEST["password"])
    initial["submit"].click.assert_called_once()
    assert REQUEST["password"] not in str(result)
    assert "username" not in result["form_evidence"]


def test_existing_console_is_reused_without_claiming_configured_identity(monkeypatch):
    fake_driver(monkeypatch, [{"authenticated": True, "password_count": 0, "company_names": ["当前公司有限公司"]}])
    result = worker.run_private(REQUEST)
    assert result["success"] and not result["login_attempted"]
    assert not result["profile_identity_verified"]
    assert result["warnings"]


@pytest.mark.parametrize("changes", [{"password_count": 0}, {"password_count": 2}, {"form_present": False},
    {"user_count": 2}, {"submit_count": 0}, {"challenge_count": 1},
    {"form_action": "http://evil.test/login"}, {"submit_action": "//evil.test/login"}])
def test_ambiguous_challenge_or_cross_origin_forms_stop_before_typing(monkeypatch, changes):
    initial = form(**changes)
    fake_driver(monkeypatch, [initial])
    result = worker.run_private(REQUEST)
    assert not result["success"] and not result["login_attempted"]
    for key in ("username", "password", "submit"):
        initial[key].clear.assert_not_called()
        initial[key].send_keys.assert_not_called()
        initial[key].click.assert_not_called()


@pytest.mark.parametrize("key", ["username", "password", "submit"])
def test_selenium_visibility_must_also_allow_the_form(monkeypatch, key):
    initial = form()
    initial[key].is_displayed.return_value = False
    fake_driver(monkeypatch, [initial])
    result = worker.run_private(REQUEST)
    assert not result["success"] and not result["login_attempted"]
    initial["username"].send_keys.assert_not_called()
    initial["password"].send_keys.assert_not_called()
    initial["submit"].click.assert_not_called()


def test_origin_change_after_username_entry_stops_before_password(monkeypatch):
    initial = form()
    driver, _ = fake_driver(monkeypatch, [initial])
    initial["username"].send_keys.side_effect = lambda _: setattr(driver, "current_url", "https://other.test")
    result = worker.run_private(REQUEST)
    assert not result["success"]
    assert "Login origin changed" in result["error"]["message"]
    initial["password"].send_keys.assert_not_called()
    initial["submit"].click.assert_not_called()


def test_changed_button_stops_after_typing_before_submit(monkeypatch):
    initial = form()
    ready = {**initial, "submit": Mock()}
    fake_driver(monkeypatch, [initial, ready])
    result = worker.run_private(REQUEST)
    assert not result["success"] and not result["login_attempted"]
    initial["submit"].click.assert_not_called()
    ready["submit"].click.assert_not_called()


def test_lost_click_response_preserves_actual_error_redacts_secret_and_never_retries(monkeypatch):
    initial = form()
    initial["submit"].click.side_effect = RuntimeError("fixture response lost: " + REQUEST["password"])
    fake_driver(monkeypatch, [initial, initial])
    result = worker.run_private(REQUEST)
    assert not result["success"] and result["login_attempted"]
    assert "fixture response lost" in result["error"]["message"]
    assert "[redacted]" in result["error"]["message"]
    assert REQUEST["password"] not in str(result)
    initial["submit"].click.assert_called_once()


def test_timeout_is_not_reported_as_authentication_success(monkeypatch):
    initial = form()
    fake_driver(monkeypatch, [initial, initial, initial])
    result = worker.run_private(REQUEST)
    assert not result["success"] and not result["authenticated"]
    assert "fixture wait expired" in result["error"]["message"]
    assert result["form_evidence"]["protected_field_count"] == 1
    initial["submit"].click.assert_called_once()


@pytest.mark.parametrize("extra", [{"provider_id": "yuntuo"}, {"password": ""}, {"store_id": "x" * 257}, {"password": "line\nbreak"}, {"token": "must-not-use"}])
def test_invalid_private_input_never_attaches(monkeypatch, extra):
    attach = Mock(side_effect=AssertionError("must not attach"))
    monkeypatch.setattr(worker, "store_driver_session", attach)
    assert not worker.run_private({**REQUEST, **extra})["success"]
    attach.assert_not_called()


def test_private_input_json_error_keeps_actual_reason_without_echoing_input(monkeypatch, capsys):
    monkeypatch.setattr(worker.sys, "stdin", SimpleNamespace(buffer=io.BytesIO(b'{"password":"private" broken}')))
    assert worker.main() == 1
    result = json.loads(capsys.readouterr().out)
    assert "Expecting ',' delimiter" in result["error"]["message"]
    assert "private" not in result["error"]["message"]


def test_actual_form_probe_checks_live_semantics_without_reading_input_values():
    bun = shutil.which("bun")
    assert bun
    script = r"""
const input = await Bun.stdin.json();
const outputs = [];
for (const scenario of ['unique', 'captcha', 'two-users', 'two-passwords', 'no-form', 'console', 'other-page']) {
  const make = (type, name, label = '') => ({type, name, id: name, autocomplete: '', placeholder: '', labels: [], disabled: false,
    innerText: label, getClientRects: () => [1], getAttribute: name => null,
    get value() { throw new Error('input value must never be read'); }});
  const user = make('text', 'username');
  const password = make('password', 'password');
  const button = make('submit', 'login', '登录');
  const inputs = [user, password];
  if (scenario === 'captcha') inputs.push(make('text', 'captcha'));
  if (scenario === 'two-users') inputs.push(make('text', 'account'));
  const form = {action: 'http://wsaexp.nextsls.com/login', querySelectorAll: q => q === 'input' ? inputs : [button]};
  password.closest = () => scenario === 'no-form' ? null : form;
  globalThis.getComputedStyle = () => ({visibility: 'visible'});
  globalThis.location = {pathname: scenario === 'console' ? '/tms/wos/home' : '/login'};
  globalThis.document = {body: {innerText: scenario === 'console' ? '发货 财务 总控平台 测试有限公司' : '登录'},
    querySelectorAll: q => q === 'input[type="password"]' ?
      (['console', 'other-page'].includes(scenario) ? [] : scenario === 'two-passwords' ? [password, password] : [password]) : []};
  const result = new Function(input.script)();
  for (const key of ['username', 'password', 'submit']) delete result[key];
  outputs.push(result);
}
process.stdout.write(JSON.stringify(outputs));
"""
    process = subprocess.run([bun, "-e", script], input=json.dumps({"script": worker.FORM_SCRIPT}),
        capture_output=True, text=True, timeout=15, check=False)
    assert process.returncode == 0, process.stderr
    outputs = json.loads(process.stdout)
    assert len(outputs) == 7
    assert outputs[0]["user_count"] == outputs[0]["password_count"] == outputs[0]["submit_count"] == 1
    assert outputs[1]["challenge_count"] == 1
    assert outputs[2]["user_count"] == 2
    assert outputs[3]["password_count"] == 2
    assert outputs[4]["form_present"] is False
    assert outputs[5]["authenticated"] is True and outputs[5]["company_names"] == ["测试有限公司"]
    assert outputs[6]["authenticated"] is False
