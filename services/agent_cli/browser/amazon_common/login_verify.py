from __future__ import annotations

import time
from typing import Any

from services.browser.browser.shadow_dom import SHADOW_DOM_HELPERS_JS


_SIGNIN_PATH = "/ap/signin"
_MFA_PATH = "/ap/mfa"
_LOGIN_PATHS = {_SIGNIN_PATH, _MFA_PATH}
_NO_LOGIN_NOTICE = "当前页面无需登录验证"
_LOGIN_DONE_NOTICE = "登录验证已完成"
_MFA_CLICK_DELAY_SECONDS = 1.5
_MAX_LOGIN_VERIFY_CLICKS = 10
_MANUAL_LOGIN_NOTICE = "登录验证自动点击已达上限，仍停留在登录页面，请让用户手动完成登录验证"


def _execute_page_script(driver: Any, script_body: str, *args):
    return driver.execute_script(SHADOW_DOM_HELPERS_JS + script_body, *args)


def _current_path(driver: Any) -> str:
    path = _execute_page_script(
        driver,
        """
return String((window.location && window.location.pathname) || '').trim();
""",
    )
    return str(path or "").strip()


def _click_current_login_button(driver: Any) -> dict[str, Any]:
    if _current_path(driver) == _MFA_PATH:
        time.sleep(_MFA_CLICK_DELAY_SECONDS)

    payload = _execute_page_script(
        driver,
        """
function clickElement(el) {
  if (!el) return false;
  try {
    el.scrollIntoView({ block: 'center', inline: 'center' });
  } catch (error) {}
  try {
    if (el.focus) el.focus();
  } catch (error) {}
  const eventTypes = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
  for (const type of eventTypes) {
    try {
      const EventClass = type.startsWith('pointer') && window.PointerEvent ? PointerEvent : MouseEvent;
      el.dispatchEvent(new EventClass(type, { bubbles: true, cancelable: true, view: window }));
    } catch (error) {
      try {
        el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      } catch (innerError) {}
    }
  }
  try {
    el.click();
    return true;
  } catch (error) {}
  return true;
}

const path = String((window.location && window.location.pathname) || '').trim();
let candidates = [];
if (path === '/ap/signin') {
  candidates = [
    ['continue', 'input#continue[type="submit"]'],
    ['signInSubmit', '#signInSubmit'],
  ];
} else if (path === '/ap/mfa') {
  candidates = [
    ['mfaSubmit', '#auth-signin-button[name="mfaSubmit"]'],
    ['auth-signin-button', '#auth-signin-button'],
  ];
} else {
  return { path, login: false, clicked: false, button: '' };
}

for (const [name, selector] of candidates) {
  const el = document.querySelector(selector);
  if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
  if (clickElement(el)) return { path, login: true, clicked: true, button: name };
}
return { path, login: true, clicked: false, button: '' };
""",
    )
    return dict(payload or {})


def verify_seller_central_login(
    driver: Any,
    *,
    timeout_seconds: int = 60,
    max_clicks: int = _MAX_LOGIN_VERIFY_CLICKS,
) -> dict[str, Any]:
    deadline = time.time() + max(1, int(timeout_seconds or 0))
    click_limit = max(1, int(max_clicks or _MAX_LOGIN_VERIFY_CLICKS))
    clicked_buttons: list[str] = []
    last_path = ""
    last_payload: dict[str, Any] = {}

    while time.time() < deadline:
        payload = _click_current_login_button(driver)
        last_payload = dict(payload or {})
        path = str(last_payload.get("path") or "").strip()
        last_path = path
        if path not in _LOGIN_PATHS:
            handled = bool(clicked_buttons)
            return {
                "handled": handled,
                "click_count": len(clicked_buttons),
                "last_path": path,
                "notice": _LOGIN_DONE_NOTICE if handled else _NO_LOGIN_NOTICE,
            }

        if bool(last_payload.get("clicked")):
            button = str(last_payload.get("button") or "").strip()
            clicked_buttons.append(button or path)
            if len(clicked_buttons) >= click_limit:
                time.sleep(0.5)
                last_path = _current_path(driver)
                if last_path not in _LOGIN_PATHS:
                    return {
                        "handled": True,
                        "click_count": len(clicked_buttons),
                        "last_path": last_path,
                        "notice": _LOGIN_DONE_NOTICE,
                    }
                return {
                    "handled": True,
                    "manual_required": True,
                    "click_count": len(clicked_buttons),
                    "last_path": last_path,
                    "notice": _MANUAL_LOGIN_NOTICE,
                }
        time.sleep(0.5)

    path_text = last_path or str(last_payload.get("path") or "").strip() or "unknown"
    raise RuntimeError(f"等待登录验证完成超时: path={path_text}")


__all__ = [
    "verify_seller_central_login",
]
