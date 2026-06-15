from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from clients.auth.browser_auth_client import ensure_auth
from services.mabang import config as mabang_settings

from .cookies import extract_named_cookies, require_cookie_values
from .errors import MabangAuthError

ERP_COOKIE_NAMES = (
    "PHPSESSID",
    "MABANG_ERP_PRO_MEMBERINFO_LOGIN_PLUS",
    "memberInfo",
)


@dataclass(frozen=True)
class MabangAuthContext:
    scope: str
    account: str
    source: str
    cookies_by_domain: dict[str, list]
    free_token: str
    wms_cookie_header: str
    raw: dict[str, Any]


def _resolve_account(scope: str, account: str) -> str:
    account_text = str(account or "").strip()
    if account_text:
        return account_text
    normalized_scope = str(scope or "").strip().lower()
    if normalized_scope in {"erp", "private_amz"}:
        return str(mabang_settings.MABANG_ACCOUNT or "").strip()
    return ""


def _normalize_cookies_by_domain(payload: dict[str, Any]) -> dict[str, list]:
    cookies_by_domain = payload.get("cookies_by_domain") or {}
    if not isinstance(cookies_by_domain, dict):
        return {}
    normalized: dict[str, list] = {}
    for domain, items in cookies_by_domain.items():
        if isinstance(items, list):
            normalized[str(domain or "").strip()] = items
    return normalized


async def ensure_mabang_auth_payload(
    scope: str,
    account: str = "",
    require_wms_cookie_header: bool = False,
    force_refresh: bool = False,
) -> dict[str, Any]:
    scope_text = str(scope or "").strip().lower()
    if not scope_text:
        raise MabangAuthError("scope 不能为空")
    resolved_account = _resolve_account(scope_text, account)
    try:
        payload = await ensure_auth(
            scope=scope_text,
            account=resolved_account,
            require_wms_cookie_header=require_wms_cookie_header,
            force_refresh=force_refresh,
        )
    except Exception as exc:
        raise MabangAuthError(f"获取 Mabang 登录态失败: {exc}") from exc
    if not isinstance(payload, dict) or not payload.get("success"):
        raise MabangAuthError("获取 Mabang 登录态失败: browser_auth_service 返回无效结果")
    return payload


async def get_auth_context(
    scope: str,
    account: str = "",
    require_wms_cookie_header: bool = False,
    force_refresh: bool = False,
) -> MabangAuthContext:
    payload = await ensure_mabang_auth_payload(
        scope=scope,
        account=account,
        require_wms_cookie_header=require_wms_cookie_header,
        force_refresh=force_refresh,
    )
    return MabangAuthContext(
        scope=str(scope or "").strip().lower(),
        account=_resolve_account(scope, account),
        source=str(payload.get("source") or "").strip(),
        cookies_by_domain=_normalize_cookies_by_domain(payload),
        free_token=str(payload.get("free_token") or "").strip(),
        wms_cookie_header=str(payload.get("wms_cookie_header") or "").strip(),
        raw=payload,
    )


async def get_erp_cookie_bundle(account: str = "") -> dict[str, str]:
    context = await get_auth_context(scope="erp", account=account)
    values = extract_named_cookies(context.cookies_by_domain, ERP_COOKIE_NAMES)
    return require_cookie_values(
        values,
        ("PHPSESSID", "MABANG_ERP_PRO_MEMBERINFO_LOGIN_PLUS"),
    )


async def get_fba_free_token(force_refresh: bool = False) -> str:
    context = await get_auth_context(
        scope="fba",
        require_wms_cookie_header=False,
        force_refresh=force_refresh,
    )
    token = str(context.free_token or "").strip()
    if not token:
        raise MabangAuthError("未获取到 freeToken")
    return token


async def get_fba_wms_cookie_header() -> str:
    context = await get_auth_context(scope="fba", require_wms_cookie_header=True)
    cookie_header = str(context.wms_cookie_header or "").strip()
    if not cookie_header:
        raise MabangAuthError("未获取到 WMS Cookie Header")
    return cookie_header
