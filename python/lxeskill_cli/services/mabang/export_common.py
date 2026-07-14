from __future__ import annotations

import re
from dataclasses import dataclass
from inspect import isawaitable
from pathlib import Path
from typing import Any, Awaitable, Callable, Generic, Iterable, TypeVar, cast
from urllib.parse import urlsplit

from services.mabang import config as mabang_settings
from services.mabang.auth import MabangAuthContext
from services.mabang.auth_constants import PRIVATE_AMZ_HOST, PRIVATE_HOST
from services.mabang.cookies import build_cookie_header, list_cookie_names

PreparedT = TypeVar("PreparedT")
AuthT = TypeVar("AuthT")
ExportT = TypeVar("ExportT")
FileT = TypeVar("FileT")
ResultT = TypeVar("ResultT")


@dataclass(frozen=True)
class PrivateAmzHeaders:
    private_amz_cookie_header: str
    private_cookie_header: str


@dataclass(frozen=True)
class ExportPipelineSpec(Generic[PreparedT, AuthT, ExportT, FileT, ResultT]):
    prepare: Callable[[], PreparedT | Awaitable[PreparedT]]
    authorize: Callable[[], Awaitable[AuthT]]
    request_export: Callable[[PreparedT, AuthT], Awaitable[tuple[ExportT, str]]]
    download_file: Callable[[PreparedT, str], Awaitable[FileT]]
    transform_result: Callable[[PreparedT, ExportT, FileT], ResultT | Awaitable[ResultT]]


async def _resolve(value: ResultT | Awaitable[ResultT]) -> ResultT:
    if isawaitable(value):
        return await cast(Awaitable[ResultT], value)
    return value


async def run_export_pipeline(
    spec: ExportPipelineSpec[PreparedT, AuthT, ExportT, FileT, ResultT],
) -> ResultT:
    prepared = await _resolve(spec.prepare())
    auth = await spec.authorize()
    exported, file_url = await spec.request_export(prepared, auth)
    downloaded = await spec.download_file(prepared, file_url)
    return await _resolve(spec.transform_result(prepared, exported, downloaded))


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
    error_type: type[Exception],
) -> PrivateAmzHeaders:
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

    return PrivateAmzHeaders(
        private_amz_cookie_header=private_amz_cookie_header,
        private_cookie_header=private_cookie_header,
    )


__all__ = [
    "ExportPipelineSpec",
    "PrivateAmzHeaders",
    "build_private_amz_headers",
    "clean_cell",
    "clean_text",
    "configured_text",
    "excel_suffix_from_url",
    "request_headers",
    "run_export_pipeline",
    "safe_store_msku_file_part",
]
