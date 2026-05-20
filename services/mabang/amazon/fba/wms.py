from __future__ import annotations

import asyncio
import os
import re
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import aiohttp

from shared.config import config
from shared.infra.net import erp_http_session
from shared.logging import logger

from ...auth import get_fba_wms_cookie_header
from ...errors import MabangAuthError, MabangBusinessError
from .consignment_paths import resolve_wms_consignment_dir

DEFAULT_WMS_EXPORT_URL = "https://wms.private.mabangerp.com/export_service/fbaamazon/ExeclFbaPackInfo2Amazon"
DEFAULT_WMS_EXPORT_ORIGIN = "https://wms.private.mabangerp.com"
DEFAULT_WMS_EXPORT_REFERER = "https://wms.private.mabangerp.com/redirect/40402/page"
AUTH_FAIL_STATUS = {401, 403}


class WmsExcelDownloadError(MabangBusinessError):
    pass


class WmsExcelAuthError(WmsExcelDownloadError, MabangAuthError):
    pass


def _normalize_ship_no(ship_no: Any) -> str:
    return str(ship_no or "").strip().upper()


def _resolve_excel_dir() -> Path:
    return resolve_wms_consignment_dir(create=True)


def _content_filename(content_disposition: str) -> str:
    text = str(content_disposition or "")
    match = re.search(r'filename="?([^";]+)"?', text, flags=re.IGNORECASE)
    if not match:
        return ""
    filename = str(match.group(1) or "").strip()
    return os.path.basename(filename)


def _is_excel_response(content_type: str, content_disposition: str) -> bool:
    ctype = str(content_type or "").lower()
    cdisp = str(content_disposition or "").lower()
    if "excel" in ctype:
        return True
    if ".xls" in cdisp or ".xlsx" in cdisp:
        return True
    return False


def _decode_response_body(body: bytes) -> str:
    if not body:
        return ""
    return body.decode("utf-8", errors="replace")


def _resolve_request_meta() -> tuple[str, str, str]:
    api_url = str(getattr(config, "FBA_LOGISTICS_WMS_EXPORT_URL", DEFAULT_WMS_EXPORT_URL) or DEFAULT_WMS_EXPORT_URL).strip()
    origin = str(getattr(config, "FBA_LOGISTICS_WMS_EXPORT_ORIGIN", DEFAULT_WMS_EXPORT_ORIGIN) or DEFAULT_WMS_EXPORT_ORIGIN).strip()
    referer = str(
        getattr(config, "FBA_LOGISTICS_WMS_EXPORT_REFERER", DEFAULT_WMS_EXPORT_REFERER) or DEFAULT_WMS_EXPORT_REFERER
    ).strip()
    return api_url, origin, referer


def _erp_request_timeout_seconds() -> str:
    timeout = getattr(getattr(erp_http_session, "timeout", None), "total", None)
    if timeout in (None, ""):
        return ""
    try:
        numeric = float(timeout)
    except Exception:
        return str(timeout)
    if numeric.is_integer():
        return str(int(numeric))
    return str(numeric)


def _format_network_error(exc: Exception, *, ship_no: str, api_url: str) -> str:
    parsed = urlsplit(str(api_url or "").strip())
    scheme = str(parsed.scheme or "").strip()
    host = str(parsed.hostname or "").strip()
    path = str(parsed.path or "/").strip() or "/"
    port: int | str = parsed.port or ""
    if not port and scheme == "https":
        port = 443
    elif not port and scheme == "http":
        port = 80

    detail = str(exc).strip()
    if not detail and isinstance(exc, asyncio.TimeoutError):
        detail = "请求超时"
    if not detail:
        detail = repr(exc)

    parts = [
        f"shipNo={ship_no}",
        "method=POST",
        f"type={type(exc).__name__}",
    ]
    if host:
        parts.append(f"host={host}")
    if port:
        parts.append(f"port={port}")
    parts.append(f"path={path}")

    timeout_text = _erp_request_timeout_seconds()
    if timeout_text:
        parts.append(f"timeout={timeout_text}s")

    os_error = getattr(exc, "os_error", None)
    if os_error is not None:
        errno = getattr(os_error, "errno", None)
        if errno is not None:
            parts.append(f"errno={errno}")
        parts.append(f"os_error={os_error}")

    parts.append(f"error={detail}")
    return "WMS 网络请求失败(" + ", ".join(parts) + ")"


def _wrap_request_error(exc: Exception, *, ship_no: str) -> Exception:
    if not isinstance(exc, (aiohttp.ClientError, asyncio.TimeoutError)):
        return exc
    api_url, _, _ = _resolve_request_meta()
    return WmsExcelDownloadError(_format_network_error(exc, ship_no=ship_no, api_url=api_url))


async def _request_once(ship_no: str, cookie_header: str) -> tuple[int, bytes, str, str]:
    api_url, origin, referer = _resolve_request_meta()

    headers = {
        "Accept": "application/vnd.ms-excel,application/octet-stream,*/*",
        "Content-Type": "application/x-www-form-urlencoded",
        "Origin": origin,
        "Referer": referer,
        "Cookie": cookie_header,
    }
    form_data = {
        "shipNo": ship_no,
        "sortTypeExport": "1",
        "isImage": "false",
    }

    async with erp_http_session.post(api_url, data=form_data, headers=headers) as resp:
        status = int(resp.status)
        body = await resp.read()
        content_type = str(resp.headers.get("Content-Type") or "")
        content_disposition = str(resp.headers.get("Content-Disposition") or "")
        return status, body, content_type, content_disposition


def _save_excel(ship_no: str, body: bytes, content_disposition: str) -> Path:
    excel_dir = _resolve_excel_dir()
    filename = _content_filename(content_disposition)
    suffix = ".xlsx" if filename.lower().endswith(".xlsx") else ".xls"
    target = excel_dir / f"{ship_no}{suffix}"
    target.write_bytes(body)
    return target


async def download_consignment_excel_from_wms(ship_no: str) -> Path:
    normalized = _normalize_ship_no(ship_no)
    if not normalized:
        raise ValueError("ship_no 不能为空")
    if not normalized.startswith("SP"):
        raise ValueError(f"ship_no 格式无效: {ship_no}")

    retry = max(0, int(getattr(config, "FBA_LOGISTICS_WMS_EXPORT_RETRY", 1) or 1))
    attempts = retry + 1
    last_error: Exception | None = None

    for idx in range(attempts):
        try:
            cookie_header = await get_fba_wms_cookie_header()
            try:
                status, body, content_type, content_disposition = await _request_once(normalized, cookie_header)
            except Exception as exc:
                wrapped = _wrap_request_error(exc, ship_no=normalized)
                if wrapped is exc:
                    raise
                raise wrapped from exc
            if status in AUTH_FAIL_STATUS:
                raise WmsExcelAuthError(f"WMS 导出鉴权失败(status={status})")
            if status >= 400:
                response_text = _decode_response_body(body)
                raise WmsExcelDownloadError(f"WMS 导出失败(status={status}): {response_text}")
            if not _is_excel_response(content_type, content_disposition):
                response_text = _decode_response_body(body)
                raise WmsExcelDownloadError(
                    f"WMS 导出返回非Excel(content_type={content_type}, disposition={content_disposition}): {response_text}"
                )
            if not body:
                raise WmsExcelDownloadError("WMS 导出返回空文件")

            saved = _save_excel(normalized, body, content_disposition)
            logger.info(
                f"[FBA Logistics][WMS] Excel 下载完成: shipNo={normalized}, file={saved.name}, size={len(body)}"
            )
            return saved
        except Exception as exc:
            last_error = exc
            logger.warning(f"[FBA Logistics][WMS] Excel 下载失败: shipNo={normalized}, attempt={idx + 1}/{attempts}, error={exc}")

    raise WmsExcelDownloadError(f"WMS 导出最终失败(shipNo={normalized}, attempts={attempts}): {last_error}")
