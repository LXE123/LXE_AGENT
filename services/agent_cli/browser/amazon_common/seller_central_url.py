from __future__ import annotations

from typing import Any
from urllib.parse import urlsplit


DEFAULT_SELLER_CENTRAL_ORIGIN = "https://sellercentral.amazon.com"
_SELLER_CENTRAL_HOST_PREFIX = "sellercentral.amazon."


def _seller_central_origin_from_url(url: str) -> str:
    raw = str(url or "").strip()
    if not raw:
        return ""
    parsed = urlsplit(raw)
    scheme = str(parsed.scheme or "").strip().lower()
    netloc = str(parsed.netloc or "").strip()
    if scheme not in {"http", "https"} or not netloc:
        return ""
    if not netloc.lower().startswith(_SELLER_CENTRAL_HOST_PREFIX):
        return ""
    return f"{scheme}://{netloc}"


def seller_central_origin(session: Any) -> str:
    driver = getattr(session, "driver", None)
    driver_url = str(getattr(driver, "current_url", "") or "").strip()
    if driver_url:
        origin = _seller_central_origin_from_url(driver_url)
        if origin:
            return origin

    return DEFAULT_SELLER_CENTRAL_ORIGIN


def build_seller_central_url(session: Any, path_with_query: str) -> str:
    raw_path = str(path_with_query or "").strip()
    if not raw_path:
        raise ValueError("path_with_query 不能为空")
    if raw_path.lower().startswith(("http://", "https://")):
        origin = _seller_central_origin_from_url(raw_path)
        if origin:
            return raw_path
        raise ValueError(f"无效的 Seller Central URL: {raw_path}")
    if not raw_path.startswith("/"):
        raw_path = f"/{raw_path}"
    return f"{seller_central_origin(session).rstrip('/')}{raw_path}"


__all__ = [
    "DEFAULT_SELLER_CENTRAL_ORIGIN",
    "build_seller_central_url",
    "seller_central_origin",
]
