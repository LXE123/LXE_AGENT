from __future__ import annotations

from http.cookies import SimpleCookie
from typing import Any
from urllib.parse import urlsplit

from shared.logging import get_logger

logger = get_logger(__name__)


def _unique_nonempty(values: list[str]) -> list[str]:
    return list(dict.fromkeys(str(value or "").strip() for value in values if str(value or "").strip()))


def _format_names(names: list[str]) -> str:
    unique_names = _unique_nonempty(names)
    return f"count={len(unique_names)} names=[{', '.join(unique_names)}]"


def _format_items(items: list[str]) -> str:
    unique_items = _unique_nonempty(items)
    return f"count={len(unique_items)} items=[{', '.join(unique_items)}]"


def cookie_header_names(cookie_header: str) -> list[str]:
    text = str(cookie_header or "").strip()
    if not text:
        return []

    parsed = SimpleCookie()
    try:
        parsed.load(text)
    except Exception:
        parsed = SimpleCookie()
    parsed_names = [str(name or "").strip() for name in parsed.keys() if str(name or "").strip()]
    if parsed_names:
        return parsed_names

    names: list[str] = []
    for part in text.split(";"):
        token = part.strip()
        if "=" not in token:
            continue
        name = token.split("=", 1)[0].strip()
        if name:
            names.append(name)
    return names


def cookie_header_summary(cookie_header: str) -> str:
    return _format_names(cookie_header_names(cookie_header))


def cookies_by_domain_summary(cookies_by_domain: dict[str, list] | None) -> str:
    items: list[str] = []
    for domain_key, cookies in (cookies_by_domain or {}).items():
        domain = str(domain_key or "").strip().lstrip(".")
        for cookie in cookies or []:
            if not isinstance(cookie, dict):
                continue
            name = str(cookie.get("name") or "").strip()
            if not name:
                continue
            cookie_domain = str(cookie.get("domain") or domain or "").strip().lstrip(".")
            items.append(f"{name}@{cookie_domain or '-'}")
    return _format_items(items)


def session_cookie_jar_summary(session: Any, url: str) -> str:
    host = str(urlsplit(str(url or "")).hostname or "").strip()
    cookie_jar = getattr(session, "cookie_jar", None)
    if cookie_jar is None:
        return f"host={host or '-'} count=0 names=[]"
    try:
        cookies = cookie_jar.filter_cookies(str(url or ""))
    except Exception as exc:
        return f"host={host or '-'} error={type(exc).__name__}"
    keys = getattr(cookies, "keys", None)
    names = [str(name or "").strip() for name in keys()] if callable(keys) else []
    return f"host={host or '-'} {_format_names(names)}"


def _clean_label(value: str, default: str = "-") -> str:
    text = str(value or "").strip()
    return text or default


def log_auth_material_acquired(
    *,
    purpose: str = "",
    caller: str = "",
    scope: str = "",
    source: str = "",
    force_refresh: bool = False,
    cookies_by_domain: dict[str, list] | None = None,
    free_token: str = "",
    wms_cookie_header: str = "",
) -> None:
    logger.info(
        "[MabangAuthAudit] event=auth_material_acquired "
        f"purpose={_clean_label(purpose)} caller={_clean_label(caller)} "
        f"scope={_clean_label(scope)} source={_clean_label(source)} "
        f"force_refresh={bool(force_refresh)} token_present={bool(str(free_token or '').strip())} "
        f"cookies_by_domain={cookies_by_domain_summary(cookies_by_domain)} "
        f"wms_cookie_header={cookie_header_summary(wms_cookie_header)}"
    )


def log_auth_material_consumed(
    *,
    purpose: str = "",
    caller: str = "",
    auth_kind: str = "",
    request_url: str = "",
    request_host: str = "",
    force_refresh: bool = False,
    cookie_header: str = "",
    token_present: bool | None = None,
    session: Any = None,
) -> None:
    host = str(request_host or "").strip() or str(urlsplit(str(request_url or "")).hostname or "").strip()
    token_text = "-" if token_present is None else str(bool(token_present))
    logger.info(
        "[MabangAuthAudit] event=auth_material_consumed "
        f"purpose={_clean_label(purpose)} caller={_clean_label(caller)} "
        f"auth_kind={_clean_label(auth_kind)} request_host={_clean_label(host)} "
        f"force_refresh={bool(force_refresh)} token_present={token_text} "
        f"cookie_header={cookie_header_summary(cookie_header)} "
        f"session_cookie_jar={session_cookie_jar_summary(session, request_url) if session is not None else '-'}"
    )


__all__ = [
    "cookie_header_names",
    "cookie_header_summary",
    "cookies_by_domain_summary",
    "log_auth_material_acquired",
    "log_auth_material_consumed",
    "session_cookie_jar_summary",
]
