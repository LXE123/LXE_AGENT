"""Desktop stdin login through the existing paired Selenium session.

Three providers share native input/click and navigation waits. Site routes live
in LOGIN_SPECS; locating controls does not depend on dashboard menu language.
"""
from __future__ import annotations

import json
import sys
from urllib.parse import urlsplit

from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from services.browser.store.store_driver_session import store_driver_session
from shared.diagnostics import diagnostic, exception_text, safe_output, safe_url
from shared.infra.cloud_client import redact

LOGIN_SPECS = {
    "wesa": {"host": "wsaexp.nextsls.com", "ready_paths": ("/tms/wos/",)},
    "tiantai": {"host": "ttaiex.nextsls.com", "ready_paths": ("/tms/wos/",)},
    "yuntuo": {
        "host": "vip.yjtms.com",
        "ready_paths": ("/home", "/customer/trackquery/"),
        "query_url": "https://vip.yjtms.com:11000/customer/trackquery/",
    },
}
LOGIN_HOSTS = {provider: spec["host"] for provider, spec in LOGIN_SPECS.items()}
USERNAME_SELECTOR = 'input[type="text"],input[type="email"],input[type="tel"],input:not([type])'
LOGIN_BUTTON_XPATH = (
    ".//*[self::button or self::input[@type='submit' or @type='button']]"
    "[contains('|登录|login|login_login|signin|', concat('|', "
    "translate(normalize-space(concat(., @value)), "
    "'ABCDEFGHIJKLMNOPQRSTUVWXYZ ', 'abcdefghijklmnopqrstuvwxyz'), '|'))]"
)


def _at_business_route(url: str, paths: tuple[str, ...]) -> bool:
    # NextSLS puts the login page under the same prefix as its business pages.
    path = urlsplit(url).path
    return path.startswith(paths) and path.rstrip("/") != "/tms/wos/login"


def _wait_for_route(driver, paths: tuple[str, ...], result: dict) -> None:
    def arrived(_):
        result["page_url"] = safe_url(driver.current_url)
        return _at_business_route(driver.current_url, paths)

    WebDriverWait(driver, 20, poll_frequency=0.5).until(arrived)


def run_private(request: dict) -> dict:
    result = {"success": False, "auth_refresh_required": False, "login_attempted": False,
              "authenticated": False, "profile_identity_verified": False}
    password = request.get("password") if isinstance(request, dict) else None
    try:
        spec = LOGIN_SPECS[request["provider_id"]]
        result.update(provider=request["provider_id"], store_id=request["store_id"])
        with store_driver_session(request["store_id"], strict_attach=True, target_host=spec["host"]) as (_, driver):
            driver.switch_to.default_content()
            result["page_url"] = safe_url(driver.current_url)
            if not _at_business_route(driver.current_url, spec["ready_paths"]):
                for selector, value in ((USERNAME_SELECTOR, request["login_username"]), ('input[type="password"]', password)):
                    element = driver.find_element(By.CSS_SELECTOR, selector)
                    element.clear()
                    element.send_keys(value)
                submit = driver.find_element(By.XPATH, LOGIN_BUTTON_XPATH)
                result["login_attempted"] = True
                submit.click()
            _wait_for_route(driver, spec["ready_paths"], result)
            if query_url := spec.get("query_url"):
                if urlsplit(driver.current_url).path != urlsplit(query_url).path:
                    driver.get(query_url)
                    _wait_for_route(driver, (urlsplit(query_url).path,), result)
            submitted = result["login_attempted"]
            result.update(success=True, authenticated=True,
                status="authenticated" if submitted else "already_authenticated",
                warnings=["Confirm the live company; configured login identity was not verified."])
            if submitted:
                result["configured_login_submitted"] = True
    except Exception as exc:
        actual = redact(exception_text(exc), secrets=(password,))
        result["error"] = {"code": "browser_login_failed", "message": diagnostic(actual)}
    return safe_output(redact(result, secrets=(password,)))


def run(arguments: dict) -> dict:
    try:
        raw = sys.stdin.buffer.read(8193)
        if len(raw) > 8192:
            raise ValueError("Private login input exceeds 8 KiB [truncated]")
        request = json.loads(raw)
    except Exception as exc:
        if isinstance(exc, UnicodeDecodeError):
            message = f"{exc.encoding}: {exc.reason}, byte positions {exc.start}–{exc.end}"
        else:
            message = str(exc)
        return {"success": False, "auth_refresh_required": False,
                "error": {"code": "invalid_private_input", "message": diagnostic(f"{type(exc).__name__}: {message}")}}
    return run_private(request)
