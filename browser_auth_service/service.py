from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright

from shared.config import config
from shared.logging import logger

PHPSESSID_COOKIE_NAME = "PHPSESSID"
PHPSESSID_HOST = "private.mabangerp.com"
PHPSESSID_EXPIRY_SKEW_SECONDS = 300
FBA_AUTH_TTL_SECONDS = 3600
LOGIN_URL = "https://private.mabangerp.com/index.htm"
TEMU_TARGET_URL = "https://private.mabangerp.com/index.php?mod=order.exportOrderByTemplate"
FBA_HOME_URL = "https://private.mabangerp.com/"
FBA_JUMP_WMS_URL = "https://private.mabangerp.com/index.php?mod=main.jumpToWms"
PRIVATE_AMZ_HOST = "private-amz.mabangerp.com"
PRIVATE_AMZ_COOKIE_REFRESH_URL = "https://private.mabangerp.com/index.php?mod=stock.list&searchStatus=3"
PRIVATE_AMZ_REQUIRED_COOKIE_NAMES = (
    "PHPSESSID",
    "MABANG_ERP_PRO_MEMBERINFO_LOGIN_COOKIE",
    "MABANG_ERP_PRO_MEMBERINFO_LOGIN_PLUS",
    "signed",
    "route",
)
KNOWN_LOGIN_HOSTS: set[str] = set()


def ensure_auth(
    scope: str,
    account: str = "",
    require_wms_cookie_header: bool = False,
) -> dict[str, Any]:
    normalized_scope = str(scope or "").strip().lower()
    if normalized_scope not in {"temu", "fba", "erp", "private_amz"}:
        raise ValueError("scope 仅支持 temu、fba、erp 或 private_amz")

    resolved_account, password = _resolve_credentials(normalized_scope, account)
    state_file = _state_file(resolved_account)
    payload = _load_storage_state_payload(state_file)
    phpsessid_status = _get_phpsessid_status(payload)

    if normalized_scope == "temu":
        return _ensure_temu_auth(
            account=resolved_account,
            password=password,
            state_file=state_file,
            payload=payload,
            phpsessid_status=phpsessid_status,
        )

    if normalized_scope == "erp":
        return _ensure_erp_auth(
            account=resolved_account,
            password=password,
            state_file=state_file,
            payload=payload,
            phpsessid_status=phpsessid_status,
        )

    if normalized_scope == "private_amz":
        return _ensure_private_amz_auth(
            account=resolved_account,
            password=password,
            state_file=state_file,
            payload=payload,
            phpsessid_status=phpsessid_status,
        )

    return _ensure_fba_auth(
        account=resolved_account,
        password=password,
        state_file=state_file,
        payload=payload,
        phpsessid_status=phpsessid_status,
        require_wms_cookie_header=require_wms_cookie_header,
    )


def _resolve_credentials(scope: str, account: str) -> tuple[str, str]:
    if scope == "temu":
        resolved_account = str(account or getattr(config, "MABANG_ACCOUNT_TEMU", "") or "").strip()
        password = str(getattr(config, "MABANG_PASSWORD_TEMU", "") or "").strip()
    else:
        resolved_account = str(account or getattr(config, "MABANG_ACCOUNT", "") or "").strip()
        password = str(getattr(config, "MABANG_PASSWORD", "") or "").strip()

    if not resolved_account:
        raise ValueError(f"{scope} 账号为空")
    if not password:
        raise ValueError(f"{scope} 密码为空")
    return resolved_account, password


def _storage_root() -> Path:
    root = Path(__file__).resolve().parent / "auth_data" / "mabang_erp"
    root.mkdir(parents=True, exist_ok=True)
    return root


def _state_file(account: str) -> Path:
    state_file = _storage_root() / account / "state.json"
    state_file.parent.mkdir(parents=True, exist_ok=True)
    return state_file


def _load_storage_state_payload(state_file: Path) -> dict[str, Any]:
    if not state_file.exists():
        return {}
    try:
        return json.loads(state_file.read_text(encoding="utf-8"))
    except Exception as exc:
        logger.warning(f"[BrowserAuth] 读取 storage_state 失败: file={state_file}, error={exc}")
        return {}


def _save_storage_state(context, state_file: Path, extra_fields: dict[str, Any] | None = None) -> dict[str, Any]:
    context.storage_state(path=str(state_file))
    payload = _load_storage_state_payload(state_file)
    if extra_fields:
        payload.update(dict(extra_fields))
    _write_storage_state_payload(state_file, payload)
    return payload


def _write_storage_state_payload(state_file: Path, payload: dict[str, Any]) -> None:
    try:
        cookies = payload.get("cookies")
        if isinstance(cookies, list):
            cookies.sort(key=lambda item: (
                str(item.get("domain") or ""),
                str(item.get("name") or ""),
                str(item.get("path") or ""),
            ))
            payload["cookies"] = cookies

        origins = payload.get("origins")
        if isinstance(origins, list):
            origins.sort(key=lambda item: str(item.get("origin") or ""))
            for origin in origins:
                local_storage = origin.get("localStorage")
                if isinstance(local_storage, list):
                    local_storage.sort(key=lambda item: str(item.get("name") or ""))
            payload["origins"] = origins

        state_file.write_text(json.dumps(payload, ensure_ascii=True, indent=2, sort_keys=True), encoding="utf-8")
    except Exception as exc:
        logger.warning(f"[BrowserAuth] storage_state 格式化失败: file={state_file}, error={exc}")


def _is_cookie_domain_match(cookie_domain: str, host: str) -> bool:
    cookie_text = str(cookie_domain or "").strip().lower().lstrip(".")
    host_text = str(host or "").strip().lower().lstrip(".")
    if not cookie_text or not host_text:
        return False
    return cookie_text == host_text or host_text.endswith(f".{cookie_text}")


def _coerce_cookie_expiry(expires: Any) -> float | None:
    try:
        value = float(expires)
    except (TypeError, ValueError):
        return None
    if value <= 0:
        return None
    return value


def _get_phpsessid_status(payload: dict[str, Any], skew_seconds: int = PHPSESSID_EXPIRY_SKEW_SECONDS) -> dict[str, Any]:
    cookies = payload.get("cookies")
    if not isinstance(cookies, list):
        return {
            "valid": False,
            "reason": "cookies_missing",
            "expires_at": None,
            "seconds_left": None,
        }

    matched_cookie = None
    for cookie in cookies:
        if not isinstance(cookie, dict):
            continue
        if str(cookie.get("name") or "").strip() != PHPSESSID_COOKIE_NAME:
            continue
        if not _is_cookie_domain_match(str(cookie.get("domain") or ""), PHPSESSID_HOST):
            continue
        matched_cookie = cookie
        break

    if not matched_cookie:
        return {
            "valid": False,
            "reason": "phpsessid_missing",
            "expires_at": None,
            "seconds_left": None,
        }

    expires_at = _coerce_cookie_expiry(matched_cookie.get("expires"))
    if expires_at is None:
        return {
            "valid": False,
            "reason": "phpsessid_expires_invalid",
            "expires_at": None,
            "seconds_left": None,
        }

    now_ts = time.time()
    seconds_left = int(expires_at - now_ts)
    if expires_at <= now_ts + max(0, int(skew_seconds or 0)):
        return {
            "valid": False,
            "reason": "phpsessid_expired",
            "expires_at": expires_at,
            "seconds_left": seconds_left,
        }

    return {
        "valid": True,
        "reason": "phpsessid_valid",
        "expires_at": expires_at,
        "seconds_left": seconds_left,
    }


def _parse_cookies_by_domain(payload: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    cookies = payload.get("cookies")
    if not isinstance(cookies, list):
        return {}

    result: dict[str, list[dict[str, Any]]] = {}
    for cookie in cookies:
        if not isinstance(cookie, dict):
            continue
        domain = str(cookie.get("domain") or "").strip().lstrip(".")
        if not domain:
            continue
        result.setdefault(domain, []).append({
            "name": str(cookie.get("name") or ""),
            "value": str(cookie.get("value") or ""),
            "domain": domain,
            "path": str(cookie.get("path") or "/"),
            "expires": cookie.get("expires"),
            "httpOnly": bool(cookie.get("httpOnly", False)),
            "secure": bool(cookie.get("secure", False)),
        })
    return result


def _storage_lookup_token(payload: dict[str, Any], origin: str, key: str) -> str:
    origins = payload.get("origins")
    if not isinstance(origins, list):
        return ""

    target_origin = str(origin or "").strip().rstrip("/")
    target_key = str(key or "").strip()
    if not target_origin or not target_key:
        return ""

    for item in origins:
        if not isinstance(item, dict):
            continue
        current_origin = str(item.get("origin") or "").strip().rstrip("/")
        if current_origin != target_origin:
            continue
        local_storage = item.get("localStorage")
        if not isinstance(local_storage, list):
            continue
        for kv in local_storage:
            if not isinstance(kv, dict):
                continue
            if str(kv.get("name") or "").strip() != target_key:
                continue
            token = str(kv.get("value") or "").strip()
            if token:
                return token
    return ""


def _storage_lookup_domain_cookies(payload: dict[str, Any], host: str) -> list[dict[str, Any]]:
    cookies = payload.get("cookies")
    if not isinstance(cookies, list):
        return []

    matched: list[dict[str, Any]] = []
    for item in cookies:
        if not isinstance(item, dict):
            continue
        if not _is_cookie_domain_match(str(item.get("domain") or ""), host):
            continue
        name = str(item.get("name") or "").strip()
        value = str(item.get("value") or "").strip()
        if not name or not value:
            continue
        matched.append(item)
    return matched


def _storage_lookup_domain_cookie_names(payload: dict[str, Any], host: str) -> set[str]:
    return {
        str(item.get("name") or "").strip()
        for item in _storage_lookup_domain_cookies(payload, host)
        if str(item.get("name") or "").strip()
    }


def _missing_cookie_names_for_host(
    payload: dict[str, Any],
    host: str,
    required_names: tuple[str, ...],
) -> list[str]:
    names = _storage_lookup_domain_cookie_names(payload, host)
    return [name for name in required_names if name not in names]


def _has_private_amz_cookie_bundle(payload: dict[str, Any]) -> bool:
    return not _missing_cookie_names_for_host(
        payload,
        PRIVATE_AMZ_HOST,
        PRIVATE_AMZ_REQUIRED_COOKIE_NAMES,
    )


def _coerce_refresh_timestamp(value: Any) -> int | None:
    try:
        numeric = int(float(value))
    except (TypeError, ValueError):
        return None
    if numeric <= 0:
        return None
    return numeric


def _storage_lookup_last_refreshed_at(payload: dict[str, Any]) -> int | None:
    if not isinstance(payload, dict):
        return None
    return _coerce_refresh_timestamp(payload.get("last_refreshed_at"))


def _is_fba_refresh_fresh(last_refreshed_at: int | None, ttl_seconds: int = FBA_AUTH_TTL_SECONDS) -> bool:
    if last_refreshed_at is None:
        return False
    return (time.time() - int(last_refreshed_at)) < max(0, int(ttl_seconds or 0))


def _build_cookie_header(cookies: list[dict[str, Any]]) -> str:
    ordered: dict[str, str] = {}
    for item in cookies:
        name = str(item.get("name") or "").strip()
        value = str(item.get("value") or "").strip()
        if name and value:
            ordered[name] = value
    return "; ".join([f"{key}={value}" for key, value in ordered.items()])


def _clear_state_file(state_file: Path) -> None:
    if not state_file.exists():
        return
    try:
        state_file.unlink()
    except Exception as exc:
        logger.warning(f"[BrowserAuth] 删除 storage_state 失败: file={state_file}, error={exc}")


def _browser_auth_headless() -> bool:
    return bool(getattr(config, "BROWSER_AUTH_HEADLESS", getattr(config, "FBA_LOGISTICS_TOKEN_HEADLESS", False)))


def _playwright_storage_state_payload(payload: dict[str, Any]) -> dict[str, Any]:
    storage_state: dict[str, Any] = {}
    cookies = payload.get("cookies")
    origins = payload.get("origins")
    if isinstance(cookies, list):
        storage_state["cookies"] = cookies
    if isinstance(origins, list):
        storage_state["origins"] = origins
    return storage_state


def _is_login_url(url: str) -> bool:
    text = str(url or "").strip().lower()
    if not text:
        return False

    parsed = urlparse(text)
    host = str(parsed.hostname or "").strip().lower()
    path = str(parsed.path or "").strip().lower()

    if host in KNOWN_LOGIN_HOSTS:
        return True
    if path == "/index.htm" or path.endswith("/index.htm"):
        return True
    if "dologin" in text:
        return True
    if "login" in text:
        return True
    return False


def _has_login_form(page) -> bool:
    try:
        has_login_button = page.locator("#login-but").count() > 0
        has_password_input = page.locator("input[type='password']").count() > 0
        has_account_input = page.locator(
            "input[type='text'], "
            "input[type='tel'], "
            "input[placeholder*='手机'], "
            "input[placeholder*='账号'], "
            "input[name*='account'], "
            "input[name*='user']"
        ).count() > 0
        return has_login_button and has_password_input and has_account_input
    except Exception:
        return False


def _is_login_page(page) -> bool:
    if _is_login_url(page.url):
        return True
    return _has_login_form(page)


def _perform_login(page, account: str, password: str) -> None:
    page.goto(LOGIN_URL, wait_until="domcontentloaded")
    page.wait_for_timeout(1000)
    page.get_by_role("textbox", name="支持手机登陆").fill(account)
    page.get_by_role("textbox", name="请输入登入密码").fill(password)
    page.locator("#login-but").click()

    try:
        page.wait_for_timeout(1500)
        page.wait_for_url(lambda value: "private.mabangerp.com/" in value, timeout=30000)
    except PlaywrightTimeoutError:
        page.wait_for_load_state("networkidle", timeout=10000)
        if _is_login_page(page):
            raise RuntimeError("登录失败")

    if _is_login_page(page):
        raise RuntimeError("登录失败")


def _open_context(browser, state_file: Path, can_reuse_state: bool):
    context_options: dict[str, Any] = {
        "accept_downloads": True,
        "viewport": {"width": 1920, "height": 1080},
    }
    if can_reuse_state and state_file.exists():
        payload = _load_storage_state_payload(state_file)
        storage_state = _playwright_storage_state_payload(payload)
        if storage_state:
            context_options["storage_state"] = storage_state
    try:
        return browser.new_context(**context_options)
    except Exception as exc:
        if "storage_state" not in context_options:
            raise
        logger.warning(f"[BrowserAuth] 加载已保存 storage_state 失败，回退为干净上下文: error={exc}")
        return browser.new_context(accept_downloads=True, viewport={"width": 1920, "height": 1080})


def _ensure_temu_auth(
    account: str,
    password: str,
    state_file: Path,
    payload: dict[str, Any],
    phpsessid_status: dict[str, Any],
) -> dict[str, Any]:
    if phpsessid_status.get("valid"):
        return {
            "success": True,
            "scope": "temu",
            "account": account,
            "source": "cache",
            "cookies_by_domain": _parse_cookies_by_domain(payload),
        }

    _clear_state_file(state_file)

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=_browser_auth_headless())
        context = _open_context(browser, state_file, can_reuse_state=False)
        try:
            page = context.new_page()
            _perform_login(page, account, password)
            page.goto(TEMU_TARGET_URL, wait_until="domcontentloaded")
            page.wait_for_timeout(1250)
            saved_payload = _save_storage_state(context, state_file)
        finally:
            context.close()
            browser.close()

    return {
        "success": True,
        "scope": "temu",
        "account": account,
        "source": "relogin",
        "cookies_by_domain": _parse_cookies_by_domain(saved_payload),
    }


def _ensure_erp_auth(
    account: str,
    password: str,
    state_file: Path,
    payload: dict[str, Any],
    phpsessid_status: dict[str, Any],
) -> dict[str, Any]:
    if phpsessid_status.get("valid"):
        return {
            "success": True,
            "scope": "erp",
            "account": account,
            "source": "cache",
            "cookies_by_domain": _parse_cookies_by_domain(payload),
        }

    _clear_state_file(state_file)

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=_browser_auth_headless())
        context = _open_context(browser, state_file, can_reuse_state=False)
        try:
            page = context.new_page()
            _perform_login(page, account, password)
            page.wait_for_timeout(1000)
            saved_payload = _save_storage_state(context, state_file)
        finally:
            context.close()
            browser.close()

    return {
        "success": True,
        "scope": "erp",
        "account": account,
        "source": "relogin",
        "cookies_by_domain": _parse_cookies_by_domain(saved_payload),
    }


def _ensure_private_amz_auth(
    account: str,
    password: str,
    state_file: Path,
    payload: dict[str, Any],
    phpsessid_status: dict[str, Any],
) -> dict[str, Any]:
    if phpsessid_status.get("valid") and _has_private_amz_cookie_bundle(payload):
        return {
            "success": True,
            "scope": "private_amz",
            "account": account,
            "source": "cache",
            "cookies_by_domain": _parse_cookies_by_domain(payload),
        }

    can_reuse_state = bool(payload) and state_file.exists()
    used_relogin = False

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=_browser_auth_headless())
        context = _open_context(browser, state_file, can_reuse_state=can_reuse_state)
        try:
            page = context.new_page()
            if not phpsessid_status.get("valid"):
                _perform_login(page, account, password)
                page.wait_for_timeout(1000)
                used_relogin = True

            _visit_private_amz_cookie_refresh_page(page)
            if _is_login_page(page):
                _perform_login(page, account, password)
                page.wait_for_timeout(1000)
                used_relogin = True
                _visit_private_amz_cookie_refresh_page(page)

            saved_payload = _save_storage_state(context, state_file)
        finally:
            context.close()
            browser.close()

    missing = _missing_cookie_names_for_host(
        saved_payload,
        PRIVATE_AMZ_HOST,
        PRIVATE_AMZ_REQUIRED_COOKIE_NAMES,
    )
    if missing:
        raise RuntimeError(f"未获取到 private-amz 关键 Cookie: {', '.join(missing)}")

    return {
        "success": True,
        "scope": "private_amz",
        "account": account,
        "source": "relogin" if used_relogin else "refresh",
        "cookies_by_domain": _parse_cookies_by_domain(saved_payload),
    }


def _visit_private_amz_cookie_refresh_page(page) -> None:
    page.goto(PRIVATE_AMZ_COOKIE_REFRESH_URL, wait_until="domcontentloaded")
    try:
        page.wait_for_load_state("networkidle", timeout=10000)
    except PlaywrightTimeoutError:
        pass
    page.wait_for_timeout(1500)


def _ensure_fba_auth(
    account: str,
    password: str,
    state_file: Path,
    payload: dict[str, Any],
    phpsessid_status: dict[str, Any],
    require_wms_cookie_header: bool,
) -> dict[str, Any]:
    token_origin = str(
        getattr(config, "FBA_LOGISTICS_TOKEN_ORIGIN", "https://amz1-private.mabangerp.com")
        or "https://amz1-private.mabangerp.com"
    ).strip()
    token_key = str(getattr(config, "FBA_LOGISTICS_TOKEN_LOCAL_STORAGE_KEY", "freeToken") or "freeToken").strip()
    target_url = str(
        getattr(config, "FBA_LOGISTICS_TOKEN_TARGET_URL", "https://private.mabangerp.com/index.php?mod=main.fbaCargo&platform=amazon&version=1")
        or "https://private.mabangerp.com/index.php?mod=main.fbaCargo&platform=amazon&version=1"
    ).strip()
    wms_host = str(getattr(config, "FBA_LOGISTICS_WMS_HOST", "wms.private.mabangerp.com") or "wms.private.mabangerp.com").strip().lower().lstrip(".")
    wms_entry_text = str(getattr(config, "FBA_LOGISTICS_WMS_ENTRY_TEXT", "马帮WMS系统") or "马帮WMS系统").strip()
    headless = bool(getattr(config, "FBA_LOGISTICS_TOKEN_HEADLESS", _browser_auth_headless()))

    cached_token = _storage_lookup_token(payload, token_origin, token_key)
    cached_wms_cookies = _storage_lookup_domain_cookies(payload, wms_host)
    last_refreshed_at = _storage_lookup_last_refreshed_at(payload)
    if _is_fba_refresh_fresh(last_refreshed_at) and cached_token and (not require_wms_cookie_header or cached_wms_cookies):
        return {
            "success": True,
            "scope": "fba",
            "account": account,
            "source": "cache",
            "cookies_by_domain": _parse_cookies_by_domain(payload),
            "free_token": cached_token,
            "wms_cookie_header": _build_cookie_header(cached_wms_cookies) if require_wms_cookie_header else "",
        }

    can_reuse_state = bool(payload) and state_file.exists()
    used_relogin = False

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=headless)
        context = _open_context(browser, state_file, can_reuse_state=can_reuse_state)
        try:
            page = context.new_page()
            if can_reuse_state:
                page.goto(FBA_HOME_URL, wait_until="domcontentloaded")
                page.wait_for_timeout(800)
                if _is_login_page(page):
                    _perform_login(page, account, password)
                    page.wait_for_timeout(1000)
                    used_relogin = True
            else:
                _perform_login(page, account, password)
                page.wait_for_timeout(1000)
                used_relogin = True

            page.goto(target_url, wait_until="domcontentloaded")
            page.wait_for_timeout(1200)
            token = _extract_token(page, token_origin, token_key)

            wms_cookie_header = ""
            if require_wms_cookie_header:
                wms_cookie_header = _collect_wms_cookie_header(page, context, wms_host, wms_entry_text)

            refreshed_at = int(time.time())
            saved_payload = _save_storage_state(
                context,
                state_file,
                extra_fields={"last_refreshed_at": refreshed_at},
            )
        finally:
            context.close()
            browser.close()

    if not token:
        token = _storage_lookup_token(saved_payload, token_origin, token_key)
    if not token:
        raise RuntimeError("未获取到 freeToken")

    if require_wms_cookie_header and not wms_cookie_header:
        wms_cookies = _storage_lookup_domain_cookies(saved_payload, wms_host)
        wms_cookie_header = _build_cookie_header(wms_cookies)
    if require_wms_cookie_header and not wms_cookie_header:
        raise RuntimeError("未获取到 WMS Cookie Header")

    return {
        "success": True,
        "scope": "fba",
        "account": account,
        "source": "relogin" if used_relogin else "refresh",
        "cookies_by_domain": _parse_cookies_by_domain(saved_payload),
        "free_token": token,
        "wms_cookie_header": wms_cookie_header,
    }


def _extract_token(page, token_origin: str, token_key: str) -> str:
    origin_url = f"{token_origin.rstrip('/')}/"
    if origin_url != "/":
        try:
            page.goto(origin_url, wait_until="domcontentloaded")
            page.wait_for_timeout(800)
        except Exception as exc:
            logger.warning(f"[BrowserAuth] 访问 token origin 失败: error={exc}")

    try:
        token = page.evaluate("(key) => window.localStorage.getItem(key)", token_key)
    except Exception as exc:
        logger.warning(f"[BrowserAuth] 页面读取 localStorage 失败: error={exc}")
        return ""

    if not isinstance(token, str):
        return ""
    return token.strip()


def _collect_wms_cookie_header(page, context, wms_host: str, wms_entry_text: str) -> str:
    page.goto(FBA_HOME_URL, wait_until="domcontentloaded")
    page.wait_for_timeout(1000)

    entry = page.get_by_role("listitem").filter(has_text=wms_entry_text)
    if entry.count() == 0:
        entry = page.locator(f"text={wms_entry_text}")
    if entry.count() == 0:
        entry = page.locator("a[href*='main.jumpToWms']")

    popup = None
    try:
        try:
            with page.expect_popup(timeout=20000) as popup_info:
                if entry.count() > 0:
                    entry.first.click(timeout=10000, force=True)
                else:
                    page.goto(FBA_JUMP_WMS_URL, wait_until="domcontentloaded")
            popup = popup_info.value
            popup.wait_for_load_state("domcontentloaded")
            monitor_page = popup
        except Exception:
            page.goto(FBA_JUMP_WMS_URL, wait_until="domcontentloaded")
            monitor_page = page

        deadline = time.time() + 30
        while time.time() < deadline:
            current_url = str(monitor_page.url or "").lower()
            if wms_host in current_url:
                break
            monitor_page.wait_for_timeout(500)
        else:
            raise RuntimeError(f"WMS 跳转超时，当前URL: {monitor_page.url}")

        monitor_page.wait_for_timeout(1000)
        cookies = context.cookies([f"https://{wms_host}/"])
        filtered = [item for item in cookies if _is_cookie_domain_match(str(item.get("domain") or ""), wms_host)]
        if not filtered:
            filtered = [item for item in context.cookies() if _is_cookie_domain_match(str(item.get("domain") or ""), wms_host)]
        return _build_cookie_header(filtered)
    finally:
        if popup is not None:
            try:
                popup.close()
            except Exception:
                pass
