from __future__ import annotations

import base64
import hashlib
import time
import uuid
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlparse

import requests

from services.yacang.errors import YacangError, safe_remote_detail
from services.yacang.production import YacangProductionGuard


WEB_ORIGIN = "http://m.seaya.cn"
DOWNLOAD_HOST = "oss-accelerate.seaya.cn"
XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
MAX_XLSX_BYTES = 50 * 1024 * 1024
DOWNLOAD_TIMEOUT = (10.0, 120.0)
DOWNLOAD_RETRY_BACKOFF_SECONDS = 5.0


def is_trusted_xlsx_url(url: str) -> bool:
    parsed = urlparse(str(url or "").strip())
    return (
        parsed.scheme == "https"
        and parsed.hostname == DOWNLOAD_HOST
        and parsed.path.lower().endswith(".xlsx")
    )


def staged_xlsx_path(destination: Path) -> Path:
    return destination.with_name(
        f".{destination.stem}.{uuid.uuid4().hex}.pending.xlsx"
    )


def download_xlsx(
    session: Any,
    url: str,
    destination: Path,
    *,
    production_guard: YacangProductionGuard | Any | None = None,
    sleep: Callable[[float], None] = time.sleep,
) -> None:
    parsed = urlparse(str(url or "").strip())
    if not is_trusted_xlsx_url(url):
        raise YacangError(
            "下载 XLSX",
            f"导出队列返回了不受信任的文件地址: scheme={parsed.scheme}, host={parsed.hostname or '[missing]'}",
        )
    guard = production_guard or YacangProductionGuard()
    attempt = 0
    while True:
        try:
            with guard.request_slot():
                response = session.get(
                    url,
                    headers={"Accept": "*/*", "Origin": WEB_ORIGIN, "Referer": f"{WEB_ORIGIN}/"},
                    allow_redirects=False,
                    stream=True,
                    timeout=DOWNLOAD_TIMEOUT,
                )
                if int(response.status_code) == 429:
                    guard.activate_rate_limit()
        except requests.RequestException as exc:
            if attempt == 0:
                attempt += 1
                sleep(DOWNLOAD_RETRY_BACKOFF_SECONDS)
                continue
            raise YacangError(
                "下载 XLSX",
                type(exc).__name__,
                code="XLSX_DOWNLOAD_NETWORK_ERROR",
                error_type=type(exc).__name__,
            ) from None
        if response.status_code == 429:
            raise YacangError(
                "下载 XLSX",
                "HTTP 429 rate_limited，已进入 15 分钟 cooldown",
                code="YACANG_RATE_LIMITED",
                http_status=429,
                scope="global",
            )
        if response.status_code == 401:
            raise YacangError(
                "下载 XLSX",
                "HTTP 401 认证失效",
                code="YACANG_AUTH_EXPIRED",
                http_status=401,
                scope="global",
            )
        if response.status_code == 403:
            raise YacangError(
                "下载 XLSX",
                "HTTP 403 已拒绝继续请求",
                code="YACANG_FORBIDDEN",
                http_status=403,
                scope="global",
            )
        if 500 <= response.status_code <= 599 and attempt == 0:
            attempt += 1
            close = getattr(response, "close", None)
            if callable(close):
                close()
            sleep(DOWNLOAD_RETRY_BACKOFF_SECONDS)
            continue
        break
    if response.status_code != 200:
        raise YacangError(
            "下载 XLSX",
            f"HTTP {response.status_code}, 响应: {safe_remote_detail(response.text)}",
            code="XLSX_DOWNLOAD_HTTP_ERROR",
            http_status=int(response.status_code),
        )
    content_type = str(response.headers.get("Content-Type") or "").split(";", 1)[0].strip().lower()
    if content_type != XLSX_CONTENT_TYPE:
        raise YacangError(
            "下载 XLSX",
            f"Content-Type 无效: {content_type or '[missing]'}",
            code="XLSX_MIME_INVALID",
        )
    try:
        declared_length = int(response.headers.get("Content-Length") or 0)
    except (TypeError, ValueError):
        raise YacangError(
            "下载 XLSX",
            "Content-Length 无效",
            code="XLSX_LENGTH_INVALID",
        ) from None
    if declared_length > MAX_XLSX_BYTES:
        raise YacangError(
            "下载 XLSX",
            f"Content-Length 超过 {MAX_XLSX_BYTES} 字节: {declared_length}",
            code="XLSX_TOO_LARGE",
        )

    temporary = destination.with_suffix(destination.suffix + ".part")
    size = 0
    md5 = hashlib.md5(usedforsecurity=False)
    try:
        with temporary.open("wb") as handle:
            for chunk in response.iter_content(chunk_size=64 * 1024):
                if not chunk:
                    continue
                size += len(chunk)
                if size > MAX_XLSX_BYTES:
                    raise YacangError(
                        "下载 XLSX",
                        f"文件超过 {MAX_XLSX_BYTES} 字节",
                        code="XLSX_TOO_LARGE",
                    )
                md5.update(chunk)
                handle.write(chunk)
        with temporary.open("rb") as handle:
            magic = handle.read(4)
        if size < 4 or magic != b"PK\x03\x04":
            raise YacangError(
                "下载 XLSX",
                "文件不是有效的 XLSX/ZIP 数据",
                code="XLSX_MAGIC_INVALID",
            )
        expected_md5 = str(response.headers.get("Content-MD5") or "").strip()
        actual_md5 = base64.b64encode(md5.digest()).decode("ascii")
        if expected_md5 and expected_md5 != actual_md5:
            raise YacangError(
                "下载 XLSX",
                "Content-MD5 校验失败",
                code="XLSX_MD5_MISMATCH",
            )
        temporary.replace(destination)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise


__all__ = [
    "DOWNLOAD_HOST",
    "DOWNLOAD_RETRY_BACKOFF_SECONDS",
    "DOWNLOAD_TIMEOUT",
    "MAX_XLSX_BYTES",
    "XLSX_CONTENT_TYPE",
    "download_xlsx",
    "is_trusted_xlsx_url",
    "staged_xlsx_path",
]
