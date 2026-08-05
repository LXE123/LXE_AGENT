from __future__ import annotations

import json
import os
import tempfile
import time
from collections.abc import Callable
from contextlib import ExitStack
from pathlib import Path
from typing import Any
from urllib.parse import urljoin, urlparse

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright

from shared.logging import get_logger
from shared.process_lock import interprocess_lock
from shared.repository import state_root
from services.mabang.auth_constants import PRIVATE_AMZ_HOST, PRIVATE_AMZ_REQUIRED_COOKIE_NAMES
from services.mabang import config as mabang_settings

from . import config as auth_settings

logger = get_logger(__name__)

PHPSESSID_COOKIE_NAME = "PHPSESSID"
PHPSESSID_HOST = "private.mabangerp.com"
PHPSESSID_EXPIRY_SKEW_SECONDS = 300
LOGIN_URL = "https://private.mabangerp.com/index.htm"
FBA_HOME_URL = "https://private.mabangerp.com/"
FBA_LOGISTICS_TOKEN_TARGET_URL = "https://private.mabangerp.com/index.php?mod=main.fbaCargo&platform=amazon&version=1"
FBA_LOGISTICS_TOKEN_ORIGIN = "https://amz1-private.mabangerp.com"
FBA_LOGISTICS_TOKEN_LOCAL_STORAGE_KEY = "freeToken"
FBA_LOGISTICS_TOKEN_WAIT_SECONDS = 10
FBA_LOGISTICS_TOKEN_POLL_INTERVAL_MS = 250
FBA_LOGISTICS_WMS_HOST = "wms.private.mabangerp.com"
FBA_LOGISTICS_WMS_ENTRY_TEXT = "马帮WMS系统"
PRIVATE_AMZ_COOKIE_REFRESH_URL = "https://private.mabangerp.com/index.php?mod=stock.list&searchStatus=3"
DINGTALK_STATE_DOMAIN = "dingtalk.com"
KNOWN_LOGIN_HOSTS: set[str] = set()
AUTH_REFRESH_LOCK_NAME = ".refresh.lock"


class BrowserAuthRefreshError(RuntimeError):
    def __init__(self, *, stage: str, current_url: str, cause: Exception) -> None:
        self.stage = str(stage or "browser").strip()
        self.current_url = str(current_url or "").strip()
        self.exception_type = type(cause).__name__
        message = str(cause or "").strip() or self.exception_type
        super().__init__(message)

    def to_payload(self) -> dict[str, Any]:
        return {
            "success": False,
            "stage": self.stage,
            "current_url": self.current_url,
            "exception_type": self.exception_type,
            "message": str(self),
        }


def refresh_auth(account: str = "") -> dict[str, Any]:
    stage = "credentials"
    _log_refresh_stage(stage=stage, status="start")
    try:
        resolved_account, password = _resolve_credentials(account)
    except Exception as exc:
        raise _refresh_error(stage=stage, current_url="", cause=exc) from exc
    _log_refresh_stage(stage=stage, status="success")

    try:
        state_file = _state_file(resolved_account)
        logger.info(
            f"[BrowserAuth] refresh start: account={_mask_account(resolved_account)}, "
            f"state_exists={state_file.exists()}"
        )
        lock_file = state_file.with_name(AUTH_REFRESH_LOCK_NAME)
        with interprocess_lock(
            lock_file,
            timeout_seconds=auth_settings.BROWSER_AUTH_LOCK_TIMEOUT_SECONDS,
        ):
            return _refresh_auth(
                account=resolved_account,
                password=password,
                state_file=state_file,
            )
    except BrowserAuthRefreshError:
        raise
    except Exception as exc:
        raise _refresh_error(stage="browser", current_url="", cause=exc) from exc


def ensure_auth(account: str = "") -> dict[str, Any]:
    """Refresh incomplete auth once while coalescing concurrent callers."""
    try:
        resolved_account = _resolve_account(account)
    except Exception as exc:
        raise _refresh_error(stage="credentials", current_url="", cause=exc) from exc

    state_file = _state_file(resolved_account)
    lock_file = state_file.with_name(AUTH_REFRESH_LOCK_NAME)
    wait_started_at = time.monotonic()
    logger.info(
        f"[BrowserAuth] ensure status=start account={_mask_account(resolved_account)} "
        f"state_exists={state_file.exists()}"
    )
    try:
        with interprocess_lock(
            lock_file,
            timeout_seconds=auth_settings.BROWSER_AUTH_LOCK_TIMEOUT_SECONDS,
        ):
            waited_ms = int(max(0.0, time.monotonic() - wait_started_at) * 1000)
            try:
                payload = _load_storage_state_payload(state_file)
                if not payload:
                    raise RuntimeError("本地认证状态不存在")
                _require_complete_auth_material(payload)
            except Exception as state_error:
                logger.info(
                    f"[BrowserAuth] ensure status=refresh account={_mask_account(resolved_account)} "
                    f"waited_ms={waited_ms} exception_type={type(state_error).__name__} "
                    f"error={str(state_error or '').strip()}"
                )
            else:
                logger.info(
                    f"[BrowserAuth] ensure status=coalesced account={_mask_account(resolved_account)} "
                    f"waited_ms={waited_ms}"
                )
                return {
                    "success": True,
                    "account": resolved_account,
                    "source": "coalesced",
                    "final_url": "",
                    "state_written": False,
                }

            _log_refresh_stage(stage="credentials", status="start")
            try:
                password = _resolve_password()
            except Exception as exc:
                raise _refresh_error(stage="credentials", current_url="", cause=exc) from exc
            _log_refresh_stage(stage="credentials", status="success")
            return _refresh_auth(
                account=resolved_account,
                password=password,
                state_file=state_file,
            )
    except BrowserAuthRefreshError:
        raise
    except Exception as exc:
        raise _refresh_error(stage="browser", current_url="", cause=exc) from exc


def read_auth(account: str = "") -> dict[str, Any]:
    """Read the latest persisted auth material without launching a browser."""
    resolved_account = str(account or mabang_settings.MABANG_ACCOUNT or "").strip()
    if not resolved_account:
        raise ValueError("Mabang 账号为空")
    state_file = _state_file(resolved_account)
    lock_file = state_file.with_name(AUTH_REFRESH_LOCK_NAME)
    with interprocess_lock(
        lock_file,
        timeout_seconds=auth_settings.BROWSER_AUTH_LOCK_TIMEOUT_SECONDS,
    ):
        payload = _load_storage_state_payload(state_file)
    if not payload:
        raise RuntimeError("本地认证状态不存在")

    token, wms_cookie_header = _require_complete_auth_material(payload)
    return {
        "success": True,
        "account": resolved_account,
        "source": "file",
        "cookies_by_domain": _parse_cookies_by_domain(payload),
        "free_token": token,
        "wms_cookie_header": wms_cookie_header,
    }


def _mask_account(account: str) -> str:
    text = str(account or "").strip()
    if len(text) <= 4:
        return text or "-"
    if len(text) <= 7:
        return f"{text[:2]}***{text[-2:]}"
    return f"{text[:3]}****{text[-4:]}"


def _log_refresh_stage(
    *,
    stage: str,
    status: str,
    current_url: str = "",
    cause: Exception | None = None,
) -> None:
    message = (
        f"[BrowserAuth] stage={stage} status={status} "
        f"url={str(current_url or '').strip() or '-'}"
    )
    if cause is None:
        logger.info(message)
        return
    logger.error(
        f"{message} exception_type={type(cause).__name__} error={str(cause or '').strip()}"
    )


def _refresh_error(*, stage: str, current_url: str, cause: Exception) -> BrowserAuthRefreshError:
    _log_refresh_stage(
        stage=stage,
        status="failed",
        current_url=current_url,
        cause=cause,
    )
    return BrowserAuthRefreshError(stage=stage, current_url=current_url, cause=cause)


def _resolve_account(account: str) -> str:
    resolved_account = str(account or mabang_settings.MABANG_ACCOUNT or "").strip()
    if not resolved_account:
        raise ValueError("Mabang 账号为空")
    return resolved_account


def _resolve_password() -> str:
    password = str(mabang_settings.MABANG_PASSWORD or "").strip()
    if not password:
        raise ValueError("Mabang 密码为空")
    return password


def _resolve_credentials(account: str) -> tuple[str, str]:
    return _resolve_account(account), _resolve_password()


def _storage_root() -> Path:
    root = state_root() / "db" / "lxeskill" / "browser_auth_service" / "mabang_erp"
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
        payload = json.loads(state_file.read_text(encoding="utf-8"))
    except Exception as exc:
        raise RuntimeError(
            f"读取本地认证状态失败: {type(exc).__name__}: {exc}"
        ) from exc
    if not isinstance(payload, dict):
        raise RuntimeError(
            f"读取本地认证状态失败: JSON 顶层必须是 object，实际为 {type(payload).__name__}"
        )
    return payload


def _is_domain_or_subdomain(value: str, domain: str) -> bool:
    text = str(value or "").strip().lower().lstrip(".")
    target = str(domain or "").strip().lower().lstrip(".")
    if not text or not target:
        return False
    return text == target or text.endswith(f".{target}")


def _cookie_name_domain_summary(cookies: list[dict[str, Any]]) -> str:
    items: list[str] = []
    for cookie in cookies or []:
        if not isinstance(cookie, dict):
            continue
        name = str(cookie.get("name") or "").strip()
        domain = str(cookie.get("domain") or "").strip().lstrip(".")
        if not name:
            continue
        items.append(f"{name}@{domain or '-'}")
    unique_items = list(dict.fromkeys(items))
    return f"count={len(unique_items)} items=[{', '.join(unique_items)}]"


def _remove_dingtalk_storage_state(payload: dict[str, Any]) -> tuple[int, int]:
    removed_cookies = 0
    cookies = payload.get("cookies")
    if isinstance(cookies, list):
        kept_cookies = []
        for cookie in cookies:
            cookie_domain = str(cookie.get("domain") or "") if isinstance(cookie, dict) else ""
            if _is_domain_or_subdomain(cookie_domain, DINGTALK_STATE_DOMAIN):
                removed_cookies += 1
                continue
            kept_cookies.append(cookie)
        payload["cookies"] = kept_cookies

    removed_origins = 0
    origins = payload.get("origins")
    if isinstance(origins, list):
        kept_origins = []
        for origin in origins:
            origin_url = str(origin.get("origin") or "") if isinstance(origin, dict) else ""
            origin_host = str(urlparse(origin_url).hostname or "")
            if _is_domain_or_subdomain(origin_host, DINGTALK_STATE_DOMAIN):
                removed_origins += 1
                continue
            kept_origins.append(origin)
        payload["origins"] = kept_origins

    return removed_cookies, removed_origins


def _save_storage_state(
    context,
    state_file: Path,
    validator: Callable[[dict[str, Any]], None] | None = None,
) -> dict[str, Any]:
    storage_payload = context.storage_state()
    if not isinstance(storage_payload, dict):
        raise RuntimeError("Playwright storage_state response must be an object")
    payload = dict(storage_payload)
    removed_cookies, removed_origins = _remove_dingtalk_storage_state(payload)
    if removed_cookies or removed_origins:
        logger.info(
            f"[BrowserAuth] 剔除 Dingtalk storage_state: cookies={removed_cookies} origins={removed_origins}"
        )
    if validator is not None:
        validator(payload)
    _write_storage_state_payload(state_file, payload)
    return payload


def _write_storage_state_payload(state_file: Path, payload: dict[str, Any]) -> None:
    temporary_path: Path | None = None
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

        state_file.parent.mkdir(parents=True, exist_ok=True)
        serialized = json.dumps(payload, ensure_ascii=True, indent=2, sort_keys=True)
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=state_file.parent,
            prefix=f".{state_file.name}.",
            suffix=".tmp",
            delete=False,
        ) as stream:
            temporary_path = Path(stream.name)
            stream.write(serialized)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary_path, state_file)
        temporary_path = None
    except Exception as exc:
        logger.warning(f"[BrowserAuth] storage_state 原子写入失败: file={state_file}, error={exc}")
        raise
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


def _is_cookie_domain_match(cookie_domain: str, host: str) -> bool:
    cookie_text = str(cookie_domain or "").strip().lower().lstrip(".")
    host_text = str(host or "").strip().lower().lstrip(".")
    if not cookie_text or not host_text:
        return False
    return cookie_text == host_text or host_text.endswith(f".{cookie_text}")


def _cookie_domain_specificity_score(cookie_domain: str, host: str) -> tuple[int, int] | None:
    cookie_text = str(cookie_domain or "").strip().lower().lstrip(".")
    host_text = str(host or "").strip().lower().lstrip(".")
    if not _is_cookie_domain_match(cookie_text, host_text):
        return None
    return (
        1 if cookie_text == host_text else 0,
        len(cookie_text),
    )


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


def _select_cookie_for_host(
    payload: dict[str, Any],
    host: str,
    name: str,
) -> dict[str, Any] | None:
    cookies = payload.get("cookies")
    if not isinstance(cookies, list):
        return None

    target_name = str(name or "").strip()
    if not target_name:
        return None

    selected: dict[str, Any] | None = None
    selected_score: tuple[int, int] | None = None
    for item in cookies:
        if not isinstance(item, dict):
            continue
        if str(item.get("name") or "").strip() != target_name:
            continue
        score = _cookie_domain_specificity_score(str(item.get("domain") or ""), host)
        if score is None:
            continue
        if selected is None or selected_score is None or score > selected_score:
            selected = item
            selected_score = score
    return selected


def _get_cookie_validity_status(
    cookie: dict[str, Any] | None,
    skew_seconds: int = PHPSESSID_EXPIRY_SKEW_SECONDS,
) -> dict[str, Any]:
    if not isinstance(cookie, dict):
        return {
            "valid": False,
            "reason": "missing",
            "expires_at": None,
            "seconds_left": None,
        }

    name = str(cookie.get("name") or "").strip()
    if not name:
        return {
            "valid": False,
            "reason": "name_missing",
            "expires_at": None,
            "seconds_left": None,
        }

    value = cookie.get("value")
    if value is None or not str(value).strip():
        return {
            "valid": False,
            "reason": "value_missing",
            "expires_at": cookie.get("expires"),
            "seconds_left": None,
        }

    raw_expires = cookie.get("expires")
    try:
        expires_at = float(raw_expires)
    except (TypeError, ValueError):
        reason = "expires_missing" if raw_expires is None else "expires_invalid"
        return {
            "valid": False,
            "reason": reason,
            "expires_at": raw_expires,
            "seconds_left": None,
        }

    if expires_at == -1:
        return {
            "valid": True,
            "reason": "session_cookie",
            "expires_at": expires_at,
            "seconds_left": None,
        }

    if expires_at <= 0:
        return {
            "valid": False,
            "reason": "expires_invalid",
            "expires_at": expires_at,
            "seconds_left": None,
        }

    now_ts = time.time()
    seconds_left = int(expires_at - now_ts)
    if expires_at <= now_ts:
        return {
            "valid": False,
            "reason": "expired",
            "expires_at": expires_at,
            "seconds_left": seconds_left,
        }

    if expires_at <= now_ts + max(0, int(skew_seconds or 0)):
        return {
            "valid": False,
            "reason": "expires_soon",
            "expires_at": expires_at,
            "seconds_left": seconds_left,
        }

    return {
        "valid": True,
        "reason": "valid",
        "expires_at": expires_at,
        "seconds_left": seconds_left,
    }


def _invalid_cookie_status_labels_for_host(
    payload: dict[str, Any],
    host: str,
    required_names: tuple[str, ...],
    skew_seconds: int = PHPSESSID_EXPIRY_SKEW_SECONDS,
) -> list[str]:
    labels: list[str] = []
    for name in required_names:
        cookie = _select_cookie_for_host(payload, host, name)
        status = _get_cookie_validity_status(cookie, skew_seconds=skew_seconds)
        if not status.get("valid"):
            labels.append(f"{name}({status.get('reason') or 'invalid'})")
    return labels


def _cookie_auth_errors(payload: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    phpsessid_status = _get_phpsessid_status(payload)
    if not phpsessid_status.get("valid"):
        errors.append(f"PHPSESSID({phpsessid_status.get('reason') or 'invalid'})")
    errors.extend(
        f"private-amz:{label}"
        for label in _invalid_cookie_status_labels_for_host(
            payload,
            PRIVATE_AMZ_HOST,
            PRIVATE_AMZ_REQUIRED_COOKIE_NAMES,
        )
    )
    return errors


def _complete_auth_material(payload: dict[str, Any]) -> tuple[str, str, list[str]]:
    errors = _cookie_auth_errors(payload)
    token = _storage_lookup_token(
        payload,
        FBA_LOGISTICS_TOKEN_ORIGIN,
        FBA_LOGISTICS_TOKEN_LOCAL_STORAGE_KEY,
    )
    if not token:
        errors.append("freeToken(missing)")

    wms_cookies = _storage_lookup_domain_cookies(payload, FBA_LOGISTICS_WMS_HOST)
    wms_cookie_header = _build_cookie_header(wms_cookies)
    if not wms_cookie_header:
        errors.append("WMS Cookie(missing)")
    return token, wms_cookie_header, errors


def _require_complete_auth_material(payload: dict[str, Any]) -> tuple[str, str]:
    token, wms_cookie_header, errors = _complete_auth_material(payload)
    if errors:
        raise RuntimeError(f"统一认证状态不完整: {', '.join(errors)}")
    return token, wms_cookie_header


def _build_cookie_header(cookies: list[dict[str, Any]]) -> str:
    ordered: dict[str, str] = {}
    for item in cookies:
        name = str(item.get("name") or "").strip()
        value = str(item.get("value") or "").strip()
        if name and value:
            ordered[name] = value
    return "; ".join([f"{key}={value}" for key, value in ordered.items()])


def _clear_state_file(state_file: Path) -> None:
    state_file.unlink(missing_ok=True)


def _launch_chromium(playwright, *, headless: bool):
    """Launch the single packaged Chromium build in headed or new-headless mode."""
    return playwright.chromium.launch(channel="chromium", headless=headless)


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


def _open_context(browser):
    return browser.new_context(
        accept_downloads=True,
        viewport={"width": 1920, "height": 1080},
    )


def _close_browser_resource(resource, label: str) -> None:
    try:
        resource.close()
    except Exception as exc:
        logger.warning(f"[BrowserAuth] {label} close failed: {exc}")


def _visit_private_amz_cookie_refresh_page(page) -> None:
    page.goto(PRIVATE_AMZ_COOKIE_REFRESH_URL, wait_until="domcontentloaded")
    try:
        page.wait_for_load_state("networkidle", timeout=10000)
    except PlaywrightTimeoutError:
        pass
    page.wait_for_timeout(1500)


def _page_url(page) -> str:
    if page is None:
        return ""
    try:
        return str(getattr(page, "url", "") or "").strip()
    except Exception:
        return ""


def _refresh_auth(
    account: str,
    password: str,
    state_file: Path,
) -> dict[str, Any]:
    token_origin = FBA_LOGISTICS_TOKEN_ORIGIN
    token_key = FBA_LOGISTICS_TOKEN_LOCAL_STORAGE_KEY
    target_url = FBA_LOGISTICS_TOKEN_TARGET_URL
    wms_host = FBA_LOGISTICS_WMS_HOST.strip().lower().lstrip(".")
    wms_entry_text = FBA_LOGISTICS_WMS_ENTRY_TEXT
    headless = bool(auth_settings.BROWSER_AUTH_HEADLESS)
    _clear_state_file(state_file)

    stage = "browser"
    page = None
    try:
        with sync_playwright() as playwright, ExitStack() as browser_resources:
            _log_refresh_stage(stage=stage, status="start")
            browser = _launch_chromium(playwright, headless=headless)
            browser_resources.callback(_close_browser_resource, browser, "browser")
            context = _open_context(browser)
            browser_resources.callback(_close_browser_resource, context, "context")
            _log_refresh_stage(stage=stage, status="success")
            page = context.new_page()

            stage = "login"
            _log_refresh_stage(stage=stage, status="start", current_url=LOGIN_URL)
            _perform_login(page, account, password)
            page.wait_for_timeout(1000)
            _log_refresh_stage(stage=stage, status="success", current_url=_page_url(page))

            stage = "inventory_sku"
            _log_refresh_stage(
                stage=stage,
                status="start",
                current_url=PRIVATE_AMZ_COOKIE_REFRESH_URL,
            )
            _visit_private_amz_cookie_refresh_page(page)
            cookie_errors = _cookie_auth_errors({"cookies": context.cookies()})
            if cookie_errors:
                raise RuntimeError(f"库存 SKU 页面认证状态不完整: {', '.join(cookie_errors)}")
            _log_refresh_stage(stage=stage, status="success", current_url=_page_url(page))

            stage = "fba_delivery"
            _log_refresh_stage(stage=stage, status="start", current_url=target_url)
            page.goto(target_url, wait_until="domcontentloaded")
            token = _extract_token(page, token_origin, token_key)
            if not token:
                raise RuntimeError("FBA 发货单页面未获取到 freeToken")
            _log_refresh_stage(stage=stage, status="success", current_url=_page_url(page))

            stage = "wms"
            _log_refresh_stage(stage=stage, status="start", current_url=FBA_HOME_URL)
            wms_cookie_header, final_url = _collect_wms_cookie_header(
                page,
                context,
                wms_host,
                wms_entry_text,
            )
            if not wms_cookie_header:
                raise RuntimeError("WMS 页面未获取到 Cookie Header")
            _log_refresh_stage(stage=stage, status="success", current_url=final_url)

            def validate_final_state(final_payload: dict[str, Any]) -> None:
                _require_complete_auth_material(final_payload)

            stage = "persist"
            _log_refresh_stage(stage=stage, status="start", current_url=final_url)
            _save_storage_state(
                context,
                state_file,
                validator=validate_final_state,
            )
            _log_refresh_stage(stage=stage, status="success", current_url=final_url)
    except BrowserAuthRefreshError:
        raise
    except Exception as exc:
        raise _refresh_error(
            stage=stage,
            current_url=_page_url(page),
            cause=exc,
        ) from exc

    return {
        "success": True,
        "account": account,
        "source": "refresh",
        "final_url": final_url,
        "state_written": True,
    }


def _frame_url(frame) -> str:
    try:
        return str(getattr(frame, "url", "") or "")
    except Exception:
        return ""


def _page_frame_urls(page) -> list[str]:
    frames = [getattr(page, "main_frame", None), *(getattr(page, "frames", []) or [])]
    urls: list[str] = []
    seen: set[int] = set()
    for frame in frames:
        if frame is None:
            continue
        marker = id(frame)
        if marker in seen:
            continue
        seen.add(marker)
        url = _frame_url(frame)
        if url:
            urls.append(url)
    return urls


def _token_candidate_frames(page, token_host: str) -> list[Any]:
    frames = [getattr(page, "main_frame", None), *(getattr(page, "frames", []) or [])]
    result: list[Any] = []
    seen: set[int] = set()
    for frame in frames:
        if frame is None:
            continue
        marker = id(frame)
        if marker in seen:
            continue
        seen.add(marker)
        frame_host = str(urlparse(_frame_url(frame)).hostname or "")
        if _is_domain_or_subdomain(frame_host, token_host):
            result.append(frame)
    return result


def _extract_token(
    page,
    token_origin: str,
    token_key: str,
    *,
    wait_seconds: float = FBA_LOGISTICS_TOKEN_WAIT_SECONDS,
    poll_interval_ms: int = FBA_LOGISTICS_TOKEN_POLL_INTERVAL_MS,
) -> str:
    token_host = str(urlparse(str(token_origin or "").strip()).hostname or "").strip().lower()
    if not token_host:
        return ""

    deadline = time.monotonic() + max(0.0, float(wait_seconds or 0))
    while True:
        for frame in _token_candidate_frames(page, token_host):
            try:
                token = frame.evaluate("(key) => window.localStorage.getItem(key)", token_key)
            except Exception:
                continue
            if isinstance(token, str) and token.strip():
                return token.strip()

        remaining_ms = int((deadline - time.monotonic()) * 1000)
        if remaining_ms <= 0:
            break
        page.wait_for_timeout(max(1, min(int(poll_interval_ms or 0), remaining_ms)))

    logger.warning(
        "[BrowserAuth] 未在 FBA token 页面读取到 localStorage: "
        f"token_host={token_host} page_url={str(getattr(page, 'url', '') or '')} frames={_page_frame_urls(page)}"
    )
    return ""


def _collect_wms_cookie_header(page, context, wms_host: str, wms_entry_text: str) -> tuple[str, str]:
    monitor_page = page
    try:
        page.goto(FBA_HOME_URL, wait_until="domcontentloaded")
        try:
            entry = page.locator("a[href*='main.jumpToWms']").first
            entry.wait_for(state="attached", timeout=10000)
        except PlaywrightTimeoutError as exc:
            raise RuntimeError(f"FBA 首页未找到 WMS 入口: {wms_entry_text}") from exc

        entry_href = str(entry.get_attribute("href") or "").strip()
        if not entry_href:
            raise RuntimeError(f"FBA 首页 WMS 入口缺少 href: {wms_entry_text}")
        page.goto(urljoin(FBA_HOME_URL, entry_href), wait_until="domcontentloaded")

        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
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
        logger.info(
            f"[BrowserAuth] WMS cookie collected: final_url={monitor_page.url}, "
            f"cookies={_cookie_name_domain_summary(filtered)}"
        )
        return _build_cookie_header(filtered), str(monitor_page.url or "")
    except BrowserAuthRefreshError:
        raise
    except Exception as exc:
        raise _refresh_error(
            stage="wms",
            current_url=_page_url(monitor_page),
            cause=exc,
        ) from exc
