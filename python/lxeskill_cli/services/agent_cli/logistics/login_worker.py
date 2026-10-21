"""Private Desktop child. Credentials arrive on stdin, never CLI flags or env.

NextSLS login uses a uniquely identified live form and native Selenium input.
No guessed login endpoint, token extraction, automatic logout or retry.
"""
from __future__ import annotations

import json
import os
import sys
from urllib.parse import urljoin, urlsplit

from selenium.webdriver.support.ui import WebDriverWait

from services.browser.store.store_driver_session import store_driver_session
from .common import diagnostic, safe_output, safe_url

LOGIN_SPECS = {
    "wesa": {"host": "wsaexp.nextsls.com", "origin": "http://wsaexp.nextsls.com"},
    "tiantai": {"host": "ttaiex.nextsls.com", "origin": "http://ttaiex.nextsls.com"},
    "yuntuo": {"host": "vip.yjtms.com", "origin": "https://vip.yjtms.com:11000",
                "login_path": "/viplogin", "target_path": "/customer/trackquery/"},
}
LOGIN_HOSTS = {provider: spec["host"] for provider, spec in LOGIN_SPECS.items()}

# This probe returns WebElements and non-secret form semantics, never input
# values, cookies, storage or HTML. Ambiguity/challenges stop before typing.
FORM_SCRIPT = r"""
const visible = el => Boolean(el && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
const passwords = [...document.querySelectorAll('input[type="password"]')].filter(visible);
const text = document.body ? document.body.innerText : '';
const markerText = text.replace(/\u00a0/g, ' ');
const provider = arguments[0];
const companies = [...new Set((text.match(/[^\s，,。;；<>]{2,80}(?:有限责任公司|有限公司)/g) || []))].slice(0, 10);
const yuntuoQuery = provider === 'yuntuo' && !passwords.length && location.pathname === '/customer/trackquery/';
const yuntuoHome = provider === 'yuntuo' && !passwords.length && location.pathname === '/home' &&
  ['快速下单', '批量下单', '财务结算', 'SYSTEM SETTING'].every(marker => markerText.includes(marker));
const result = {password_count: passwords.length, company_names: companies,
  authenticated: provider === 'yuntuo' ? yuntuoQuery || yuntuoHome
    : !passwords.length && location.pathname.startsWith('/tms/wos/') && text.includes('发货') &&
      text.includes('财务') && text.includes('总控平台')};
if (provider === 'yuntuo') {
  result.query_ready = yuntuoQuery;
  result.authenticated_route = yuntuoQuery ? 'query' : yuntuoHome ? 'home' : null;
}
if (passwords.length !== 1) return result;
const password = passwords[0];
const form = password.closest('form');
const yuntuoDivLayout = provider === 'yuntuo' && !form;
if (!form && !yuntuoDivLayout) return {...result, form_present: false};
const root = form || document;
const inputs = [...root.querySelectorAll('input')].filter(el => visible(el) && !el.disabled);
const semantics = el => [el.name, el.id, el.type, el.autocomplete, el.placeholder,
  el.getAttribute('aria-label'), ...[...(el.labels || [])].map(label => label.innerText)].filter(Boolean).join(' ');
const challenges = inputs.filter(el => /captcha|验证码|校验码|动态码|短信|一次性|one.time|otp/i.test(semantics(el)));
const challengeFrames = [...document.querySelectorAll('iframe')].filter(el => visible(el) && /captcha|recaptcha|hcaptcha|challenge/i.test([el.src, el.title].join(' ')));
const textInputs = inputs.filter(el => ['text', 'email', 'tel'].includes(el.type) && !challenges.includes(el));
const namedUsers = yuntuoDivLayout
  ? textInputs.filter(el => el.placeholder === 'LOGIN_ACCOUNT')
  : textInputs.filter(el => /username|user.name|login|account|email|账号|帐号|用户名|邮箱/i.test(semantics(el)));
const users = yuntuoDivLayout ? namedUsers : (namedUsers.length ? namedUsers : textInputs);
const buttons = [...root.querySelectorAll('button,input[type="submit"],input[type="button"]')].filter(el => visible(el) && !el.disabled &&
  (yuntuoDivLayout ? el.type === 'button' && (el.innerText || '').trim() === 'LOGIN_LOGIN'
    : /^(登\s*录|login|log\s*in|sign\s*in)$/i.test((el.innerText || el.getAttribute('value') || '').trim())));
const exactPassword = !yuntuoDivLayout || password.placeholder === 'PASSWORD' ? password : null;
let controlsGrouped = !yuntuoDivLayout;
if (yuntuoDivLayout && users.length === 1 && buttons.length === 1 && exactPassword) {
  let ancestor = exactPassword.parentElement;
  for (let depth = 0; ancestor && depth < 8; depth++, ancestor = ancestor.parentElement) {
    if (ancestor.contains(users[0]) && ancestor.contains(buttons[0])) { controlsGrouped = true; break; }
  }
}
return {...result, form_present: Boolean(form), vendor_layout: yuntuoDivLayout ? 'yuntuo_div_controls' : null,
  controls_grouped: controlsGrouped, user_count: users.length, submit_count: buttons.length,
  challenge_count: challenges.length + challengeFrames.length,
  form_action: form ? form.action : null, submit_action: buttons.length === 1 ? buttons[0].getAttribute('formaction') : null,
  username: users.length === 1 ? users[0] : null, password: exactPassword,
  submit: buttons.length === 1 ? buttons[0] : null,
  errors: [...document.querySelectorAll('[role="alert"],.error-message,.alert-danger')]
    .filter(visible).map(el => el.innerText).join('\n').slice(0, 2000)};
"""


def _origin(url: str) -> str:
    parsed = urlsplit(url)
    if parsed.username or parsed.password:
        raise ValueError("Browser URL must not contain credentials")
    return f"{parsed.scheme}://{parsed.netloc}"


def _guard(driver, origin: str) -> None:
    if _origin(driver.current_url) != origin:
        raise ValueError("Login origin changed: " + safe_url(driver.current_url))


def _probe(driver, origin: str, provider: str) -> dict:
    _guard(driver, origin)
    evidence = driver.execute_script(FORM_SCRIPT, provider)
    if not isinstance(evidence, dict):
        raise ValueError("Login form probe returned a non-object")
    return evidence


def _evidence(probe: dict) -> dict:
    result = {key: probe[key] for key in ("form_present", "user_count", "submit_count",
              "challenge_count", "authenticated", "company_names", "errors", "vendor_layout",
              "controls_grouped", "query_ready", "authenticated_route") if key in probe}
    if "password_count" in probe:
        result["protected_field_count"] = probe["password_count"]
    return result


def _validate_form(probe: dict, origin: str, page_url: str, provider: str) -> None:
    if probe.get("challenge_count", 0):
        raise ValueError("Login requires human verification; observed form: " + diagnostic(_evidence(probe)))
    container_valid = probe.get("form_present") is True or (provider == "yuntuo"
        and probe.get("vendor_layout") == "yuntuo_div_controls" and probe.get("controls_grouped") is True)
    if (probe.get("password_count") != 1 or not container_valid
            or probe.get("user_count") != 1 or probe.get("submit_count") != 1
            or not all(probe.get(key) is not None for key in ("username", "password", "submit"))):
        raise ValueError("Login form is not uniquely identifiable: " + diagnostic(_evidence(probe)))
    for key in ("username", "password", "submit"):
        if not probe[key].is_displayed() or not probe[key].is_enabled():
            raise ValueError(f"Login {key} element is not visible and enabled")
    for action in (probe.get("form_action"), probe.get("submit_action")):
        if action is not None and _origin(urljoin(page_url, action)) != origin:
            raise ValueError("Login form action has an unexpected origin: " + safe_url(urljoin(page_url, action)))


def _open_yuntuo_query(driver, origin: str, provider: str, target_path: str) -> dict:
    driver.get(origin + target_path)
    last: dict = {}

    def ready(_):
        nonlocal last
        last = _probe(driver, origin, provider)
        return (last.get("query_ready") is True or bool(last.get("errors"))
                or bool(last.get("challenge_count")) or last.get("password_count", 0) > 0)

    WebDriverWait(driver, 20, poll_frequency=0.5).until(ready)
    if last.get("query_ready") is not True:
        raise ValueError("Authenticated Yuntuo session did not reach the fixed query page: "
                         + diagnostic(_evidence(last)))
    return last


def run_private(request: dict) -> dict:
    result = {"success": False, "auth_refresh_required": False, "login_attempted": False,
              "authenticated": False, "profile_identity_verified": False}
    password = request.get("password") if isinstance(request, dict) else None

    def clean(value):
        if isinstance(value, str):
            return value.replace(password, "[redacted]") if isinstance(password, str) and password else value
        if isinstance(value, list):
            return [clean(item) for item in value]
        if isinstance(value, dict):
            return {key: clean(item) for key, item in value.items()}
        return value

    try:
        if not isinstance(request, dict) or set(request) != {"provider_id", "store_id", "login_username", "password"}:
            raise ValueError("Expected only provider_id, store_id, login_username and password")
        for key, limit in (("store_id", 256), ("login_username", 200), ("password", 1024)):
            value = request[key]
            if not isinstance(value, str) or not value or len(value) > limit or any(ord(ch) < 32 or ord(ch) == 127 for ch in value):
                raise ValueError(f"Invalid private login field: {key}")
        provider = request["provider_id"]
        if not isinstance(provider, str) or provider not in LOGIN_HOSTS:
            raise ValueError("Automatic login form support is not yet verified for this logistics provider")
        if not os.environ.get("LXE_AGENT_SESSION_ID", "").strip():
            raise ValueError("LXE_AGENT_SESSION_ID is required for logistics login")
        spec = LOGIN_SPECS[provider]
        host, origin = spec["host"], spec["origin"]
        with store_driver_session(request["store_id"], strict_attach=True, target_host=host) as (_, driver):
            driver.switch_to.default_content()
            result.update(provider=provider, store_id=request["store_id"], page_url=safe_url(driver.current_url))
            initial = _probe(driver, origin, provider)
            result["form_evidence"] = _evidence(initial)
            if initial.get("authenticated") is True:
                if provider == "yuntuo" and initial.get("query_ready") is not True:
                    try:
                        initial = _open_yuntuo_query(driver, origin, provider, spec["target_path"])
                    finally:
                        result["form_evidence"] = _evidence(initial)
                        result["page_url"] = safe_url(driver.current_url)
                result.update(success=True, authenticated=True, status="already_authenticated",
                    warnings=["Existing browser login reused; configured login identity was not verified. Confirm the live company before querying."])
            else:
                if provider == "yuntuo" and urlsplit(driver.current_url).path.rstrip("/") != spec["login_path"]:
                    raise ValueError("Expected the Yuntuo login page or authenticated query page; observed "
                                     + safe_url(driver.current_url))
                _validate_form(initial, origin, driver.current_url, provider)
                initial["username"].clear()
                _guard(driver, origin)
                initial["username"].send_keys(request["login_username"])
                _guard(driver, origin)
                initial["password"].clear()
                _guard(driver, origin)
                initial["password"].send_keys(password)
                # Recheck origin, destination and uniqueness after framework
                # updates. A replaced button is not silently substituted.
                ready = _probe(driver, origin, provider)
                _validate_form(ready, origin, driver.current_url, provider)
                if ready["submit"] != initial["submit"]:
                    raise ValueError("Login submit element changed while entering credentials")
                _guard(driver, origin)
                result["login_attempted"] = True
                initial["submit"].click()
                last = initial
                def finished(_):
                    nonlocal last
                    last = _probe(driver, origin, provider)
                    yuntuo_unverified_landing = (provider == "yuntuo" and last.get("password_count") == 0
                        and urlsplit(driver.current_url).path.rstrip("/") != spec["login_path"]
                        and last.get("authenticated") is not True)
                    return (last.get("authenticated") is True or bool(last.get("errors"))
                            or bool(last.get("challenge_count")) or yuntuo_unverified_landing)

                try:
                    WebDriverWait(driver, 20, poll_frequency=0.5).until(finished)
                    if provider == "yuntuo" and last.get("authenticated") is True and last.get("query_ready") is not True:
                        last = _open_yuntuo_query(driver, origin, provider, spec["target_path"])
                finally:
                    result["form_evidence"] = _evidence(last)
                    result["page_url"] = safe_url(driver.current_url)
                if last.get("authenticated") is not True or (provider == "yuntuo" and last.get("query_ready") is not True):
                    raise ValueError("Login did not reach the authenticated console: " + diagnostic(_evidence(last)))
                result.update(success=True, authenticated=True, configured_login_submitted=True, status="authenticated",
                    warnings=["Configured credentials were submitted and the authenticated console was observed; confirm the live company before querying."])
    except Exception as exc:
        parts = [f"{type(exc).__name__}: {exc}"]
        cause = exc.__cause__
        for _ in range(3):
            if cause is None:
                break
            parts.append(f"caused by {type(cause).__name__}: {cause}")
            cause = cause.__cause__
        result["error"] = {"code": "browser_login_failed", "message": diagnostic(clean("; ".join(parts)))}
    return safe_output(clean(result))


def main() -> int:
    try:
        raw = sys.stdin.buffer.read(8193)
        if len(raw) > 8192:
            raise ValueError("Private login input exceeds 8 KiB [truncated]")
        request = json.loads(raw)
    except Exception as exc:
        if isinstance(exc, json.JSONDecodeError):
            message = f"{exc.msg}: line {exc.lineno} column {exc.colno} (char {exc.pos})"
        elif isinstance(exc, UnicodeDecodeError):
            message = f"{exc.encoding}: {exc.reason}, byte positions {exc.start}–{exc.end}"
        else:
            message = str(exc)
        result = {"success": False, "auth_refresh_required": False,
                  "error": {"code": "invalid_private_input", "message": diagnostic(f"{type(exc).__name__}: {message}")}}
    else:
        result = run_private(request)
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result["success"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
