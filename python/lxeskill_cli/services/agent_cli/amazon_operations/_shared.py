from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import json
import re
from typing import Any, Mapping

import requests

from shared.infra.net.requests_client import external_requests_session
from shared.workspace import artifact_path


SOURCE = "amazon_public_web"
SUPPORTED_MARKETPLACE = "com"
REQUEST_TIMEOUT_SECONDS = 15
_BLOCKED_HTTP_STATUSES = {403, 429, 503}
_BLOCK_MARKERS = (
    "robot check",
    "validatecaptcha",
    "enter the characters you see below",
    "sorry, we just need to make sure you're not a robot",
    "type the characters you see in this image",
)
_SAFE_STEM = re.compile(r"[^a-zA-Z0-9._-]+")


@dataclass(frozen=True)
class WebResponse:
    requested_url: str
    final_url: str
    status_code: int | None
    text: str
    content_type: str
    exception_type: str = ""
    error: str = ""


def validate_marketplace(value: Any) -> str:
    marketplace = str(value or SUPPORTED_MARKETPLACE).strip().lower()
    if marketplace != SUPPORTED_MARKETPLACE:
        raise ValueError("marketplace must be 'com' for this release")
    return marketplace


def required_text(value: Any, *, field: str, max_length: int = 200) -> str:
    text = " ".join(str(value or "").split())
    if not text:
        raise ValueError(f"{field} is required")
    if len(text) > max_length:
        raise ValueError(f"{field} must be at most {max_length} characters")
    return text


def integer_in_range(value: Any, *, field: str, default: int, minimum: int, maximum: int) -> int:
    raw = default if value in (None, "") else value
    try:
        number = int(raw)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{field} must be an integer") from exc
    if number < minimum or number > maximum:
        raise ValueError(f"{field} must be between {minimum} and {maximum}")
    return number


def fetch_web(
    url: str,
    *,
    headers: Mapping[str, str] | None = None,
    params: Mapping[str, Any] | None = None,
) -> WebResponse:
    try:
        response = external_requests_session.get(
            url,
            headers=dict(headers or {}),
            params=dict(params or {}),
            timeout=REQUEST_TIMEOUT_SECONDS,
        )
    except requests.RequestException as exc:
        return WebResponse(
            requested_url=url,
            final_url=url,
            status_code=None,
            text="",
            content_type="",
            exception_type=type(exc).__name__,
            error=str(exc),
        )
    return WebResponse(
        requested_url=url,
        final_url=str(getattr(response, "url", url) or url),
        status_code=int(response.status_code),
        text=str(response.text or ""),
        content_type=str(response.headers.get("Content-Type") or ""),
    )


def blocked_reason(response: WebResponse) -> str:
    if response.status_code in _BLOCKED_HTTP_STATUSES:
        return f"http_{response.status_code}"
    lowered = response.text.lower()
    return next((marker for marker in _BLOCK_MARKERS if marker in lowered), "")


def response_diagnostics(response: WebResponse) -> dict[str, Any]:
    return {
        "http_status": response.status_code,
        "final_url": response.final_url,
        "content_type": response.content_type,
        "exception_type": response.exception_type,
        "error": response.error,
        "blocked_marker": blocked_reason(response),
    }


def failure_payload(
    message: str,
    *,
    marketplace: str = SUPPORTED_MARKETPLACE,
    status: str = "failed",
    diagnostics: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "success": False,
        "status": status,
        "source": SOURCE,
        "marketplace": marketplace,
        "message": message,
        "diagnostics": {"confidence": "none", **dict(diagnostics or {})},
        "report_path": "",
    }


def persist_report(category: str, identity: str, payload: Mapping[str, Any]) -> dict[str, Any]:
    directory = artifact_path("amazon_operations", category)
    directory.mkdir(parents=True, exist_ok=True)
    safe_identity = _SAFE_STEM.sub("-", identity).strip("-._")[:60] or "report"
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    path = directory / f"{safe_identity}-{timestamp}.json"
    document = {**dict(payload), "report_path": str(path.resolve())}
    path.write_text(json.dumps(document, ensure_ascii=False, indent=2), encoding="utf-8")
    return document


def parse_count(value: str) -> int | None:
    digits = re.sub(r"[^0-9]", "", value or "")
    return int(digits) if digits else None


def compact_error(response: WebResponse) -> str:
    if response.error:
        return f"{response.exception_type}: {response.error}".strip(": ")
    if response.status_code is not None and not 200 <= response.status_code < 300:
        return f"Amazon returned HTTP {response.status_code}"
    return "Amazon returned an unrecognized response"


__all__ = [
    "SOURCE",
    "SUPPORTED_MARKETPLACE",
    "WebResponse",
    "blocked_reason",
    "compact_error",
    "failure_payload",
    "fetch_web",
    "integer_in_range",
    "parse_count",
    "persist_report",
    "required_text",
    "response_diagnostics",
    "validate_marketplace",
]
