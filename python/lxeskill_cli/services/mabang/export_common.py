from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Awaitable, Callable, Generic, Iterable, TypeVar
from urllib.parse import urlsplit

from services.mabang import config as mabang_settings
from services.mabang.auth import MabangAuthContext
from services.mabang.auth_constants import PRIVATE_AMZ_HOST, PRIVATE_HOST
from services.mabang.cookies import (
    build_cookie_header,
    extract_named_cookies,
    list_cookie_names,
)

FileT = TypeVar("FileT")
ResultT = TypeVar("ResultT")


@dataclass(frozen=True)
class PrivateAmzExportAuth:
    private_amz_cookie_header: str
    private_cookie_header: str
    memcache_key: str


@dataclass(frozen=True)
class ExportPipelineSpec(Generic[FileT, ResultT]):
    authorize: Callable[[], Awaitable[PrivateAmzExportAuth]]
    fetch_ids: Callable[..., Awaitable[list[str]]]
    request_file_url: Callable[..., Awaitable[str]]
    download_file: Callable[[str], Awaitable[FileT]]
    transform_result: Callable[[list[str], FileT], ResultT]
    fetch_args: tuple[Any, ...] = ()


async def run_export_pipeline(spec: ExportPipelineSpec[FileT, ResultT]) -> ResultT:
    auth = await spec.authorize()
    ids = await spec.fetch_ids(
        *spec.fetch_args,
        cookie_header=auth.private_amz_cookie_header,
    )
    file_url = await spec.request_file_url(
        ids,
        cookie_header=auth.private_cookie_header,
        memcache_key=auth.memcache_key,
    )
    downloaded = await spec.download_file(file_url)
    return spec.transform_result(ids, downloaded)


def configured_text(name: str, default: str) -> str:
    return mabang_settings.configured_text(name, default)


def clean_cell(value: Any) -> str:
    text = str(value or "").strip()
    if text.lower() == "nan":
        return ""
    return text


def clean_text(value: Any) -> str:
    return str(value or "").strip()


def safe_store_msku_file_part(value: Any) -> str:
    text = clean_text(value)
    text = re.sub(r"[^A-Za-z0-9_.-]+", "_", text)
    return text.strip("._-") or "store_msku"


def request_headers(cookie_header: str, *, origin: str, referer: str) -> dict[str, str]:
    return {
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
        "Origin": origin,
        "Referer": referer,
        "Cookie": cookie_header,
    }


def excel_suffix_from_url(file_url: str) -> str:
    suffix = Path(urlsplit(str(file_url or "")).path).suffix.lower()
    if suffix in {".xls", ".xlsx"}:
        return suffix
    return ".xls"


def build_private_amz_headers(
    context: MabangAuthContext,
    *,
    required_names: Iterable[str],
    extra_cookies: dict[str, str],
    private_extra_cookies: dict[str, str],
    memcache_cookie_name: str,
    error_type: type[Exception],
) -> PrivateAmzExportAuth:
    private_amz_cookie_header = build_cookie_header(
        context.cookies_by_domain,
        request_host=PRIVATE_AMZ_HOST,
        extra_cookies=extra_cookies,
    )
    if not private_amz_cookie_header:
        raise error_type("未获取到 private-amz.mabangerp.com Cookie")

    private_amz_cookie_names = set(
        list_cookie_names(
            context.cookies_by_domain,
            request_host=PRIVATE_AMZ_HOST,
            extra_cookies=extra_cookies,
        )
    )
    missing_private_amz = [name for name in required_names if name not in private_amz_cookie_names]
    if missing_private_amz:
        raise error_type(f"缺少 private-amz 关键 Cookie: {', '.join(missing_private_amz)}")

    private_cookie_header = build_cookie_header(
        context.cookies_by_domain,
        request_host=PRIVATE_HOST,
        extra_cookies=private_extra_cookies,
    )
    if not private_cookie_header:
        raise error_type("未获取到 private.mabangerp.com Cookie")

    values = extract_named_cookies(context.cookies_by_domain, (memcache_cookie_name,))
    memcache_key = clean_text(values.get(memcache_cookie_name))
    if not memcache_key:
        raise error_type(f"缺少关键 Cookie: {memcache_cookie_name}")

    return PrivateAmzExportAuth(
        private_amz_cookie_header=private_amz_cookie_header,
        private_cookie_header=private_cookie_header,
        memcache_key=memcache_key,
    )
