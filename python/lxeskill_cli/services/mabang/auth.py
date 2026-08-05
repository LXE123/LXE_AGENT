from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from browser_auth_service.client import BrowserAuthClientError, ensure_auth, read_auth, refresh_auth
from services.mabang import config as mabang_settings

from . import auth_audit
from .errors import MabangAuthError


@dataclass(frozen=True)
class MabangAuthContext:
    account: str
    source: str
    cookies_by_domain: dict[str, list]
    free_token: str
    wms_cookie_header: str


def _resolve_account(account: str) -> str:
    resolved_account = str(account or mabang_settings.MABANG_ACCOUNT or "").strip()
    if not resolved_account:
        raise MabangAuthError("Mabang 账号为空")
    return resolved_account


def _normalize_cookies_by_domain(payload: dict[str, Any]) -> dict[str, list]:
    cookies_by_domain = payload.get("cookies_by_domain") or {}
    if not isinstance(cookies_by_domain, dict):
        return {}
    normalized: dict[str, list] = {}
    for domain, items in cookies_by_domain.items():
        if isinstance(items, list):
            normalized[str(domain or "").strip()] = items
    return normalized


async def refresh_mabang_auth(
    account: str = "",
    purpose: str = "",
) -> dict[str, Any]:
    resolved_account = _resolve_account(account)
    try:
        return await refresh_auth(account=resolved_account)
    except Exception as exc:
        purpose_label = str(purpose or "").strip() or "-"
        raise MabangAuthError(
            f"刷新 Mabang 登录态失败(purpose={purpose_label}): {exc}"
        ) from exc


async def _ensure_mabang_auth(
    *,
    account: str,
    purpose: str,
) -> dict[str, Any]:
    try:
        return await ensure_auth(account=account)
    except Exception as exc:
        purpose_label = str(purpose or "").strip() or "-"
        raise MabangAuthError(
            f"自动恢复 Mabang 登录态失败(purpose={purpose_label}): {exc}"
        ) from exc


async def _read_auth_context(
    *,
    account: str,
    purpose: str,
) -> MabangAuthContext:
    payload = await read_auth(account=account)
    if not isinstance(payload, dict) or not payload.get("success"):
        raise BrowserAuthClientError("读取 browser_auth_service 状态失败")

    cookies_by_domain = _normalize_cookies_by_domain(payload)
    free_token = str(payload.get("free_token") or "").strip()
    wms_cookie_header = str(payload.get("wms_cookie_header") or "").strip()
    auth_audit.log_auth_material_acquired(
        purpose=purpose,
        caller="services.mabang.auth.get_auth_context",
        source=str(payload.get("source") or "").strip(),
        cookies_by_domain=cookies_by_domain,
        free_token=free_token,
        wms_cookie_header=wms_cookie_header,
    )
    return MabangAuthContext(
        account=account,
        source=str(payload.get("source") or "").strip(),
        cookies_by_domain=cookies_by_domain,
        free_token=free_token,
        wms_cookie_header=wms_cookie_header,
    )


async def get_auth_context(
    account: str = "",
    purpose: str = "",
) -> MabangAuthContext:
    resolved_account = _resolve_account(account)
    try:
        try:
            return await _read_auth_context(account=resolved_account, purpose=purpose)
        except BrowserAuthClientError:
            await _ensure_mabang_auth(
                account=resolved_account,
                purpose=str(purpose or "").strip() or "missing_or_incomplete_state",
            )
            return await _read_auth_context(account=resolved_account, purpose=purpose)
    except MabangAuthError:
        raise
    except Exception as exc:
        raise MabangAuthError(f"获取 Mabang 登录态失败: {exc}") from exc


async def get_fba_free_token(purpose: str = "") -> str:
    context = await get_auth_context(purpose=purpose)
    token = str(context.free_token or "").strip()
    if not token:
        raise MabangAuthError("未获取到 freeToken")
    return token


async def get_fba_wms_cookie_header(purpose: str = "") -> str:
    context = await get_auth_context(purpose=purpose)
    cookie_header = str(context.wms_cookie_header or "").strip()
    if not cookie_header:
        raise MabangAuthError("未获取到 WMS Cookie Header")
    return cookie_header
