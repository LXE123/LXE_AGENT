from __future__ import annotations

import json
import re
from typing import Any


_SENSITIVE_KEYS = {
    "authorization",
    "captcha",
    "cookie",
    "key",
    "mobile",
    "password",
    "path",
    "php_sess_id",
    "phpsessid",
    "token",
    "verify_code",
    "url",
}
_JWT_PATTERN = re.compile(r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b")
_PHONE_PATTERN = re.compile(r"(?<!\d)1\d{10}(?!\d)")
_SESSION_PATTERN = re.compile(r"(?i)\bPHPSESSID=[^\s;,]+")
_URL_PATTERN = re.compile(r"https?://[^\s\"'<>]+", re.IGNORECASE)
_SECRET_ASSIGNMENT_PATTERN = re.compile(
    r"(?i)([\"']?\b(authorization|captcha|cookie|key|mobile|password|session|token|verify_code)"
    r"\b[\"']?\s*[:=]\s*[\"']?)([^\s,;\"'}]+)"
)
_SENSITIVE_HEADER_PATTERN = re.compile(
    r"(?im)\b(authorization|cookie|set-cookie|token|warehouse-token|proxy-token|proxys-token)"
    r"\s*[:=]\s*[^\r\n]+"
)
_BEARER_PATTERN = re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]+")


def safe_remote_detail(value: Any, *, limit: int = 800) -> str:
    """Keep the real remote error shape while removing credentials and huge bodies."""

    def redact(item: Any) -> Any:
        if isinstance(item, dict):
            return {
                str(name): "[REDACTED]" if str(name).lower() in _SENSITIVE_KEYS else redact(child)
                for name, child in item.items()
            }
        if isinstance(item, list):
            return [redact(child) for child in item[:20]]
        if isinstance(item, str):
            if item.startswith("data:image/"):
                return "[REDACTED_DATA_IMAGE]"
            text = _JWT_PATTERN.sub("[REDACTED_TOKEN]", item)
            text = _PHONE_PATTERN.sub("[REDACTED_MOBILE]", text)
            text = _SESSION_PATTERN.sub("PHPSESSID=[REDACTED]", text)
            text = _SENSITIVE_HEADER_PATTERN.sub(
                lambda match: f"{match.group(1)}=[REDACTED]",
                text,
            )
            text = _BEARER_PATTERN.sub("Bearer [REDACTED]", text)
            text = _SECRET_ASSIGNMENT_PATTERN.sub(
                lambda match: f"{match.group(1)}[REDACTED]",
                text,
            )
            return _URL_PATTERN.sub("[REDACTED_URL]", text)
        return item

    if isinstance(value, (dict, list)):
        text = json.dumps(redact(value), ensure_ascii=False, separators=(",", ":"))
    else:
        text = str(redact(str(value or "").strip()))
    return text if len(text) <= limit else f"{text[:limit]}...[truncated]"


class YacangError(RuntimeError):
    """A factual, already-sanitized Yacang workflow failure."""

    def __init__(
        self,
        stage: str,
        message: str,
        *,
        code: str = "YACANG_ERROR",
        http_status: int | None = None,
        error_type: str | None = None,
        scope: str = "local",
    ) -> None:
        self.stage = stage
        self.code = code
        self.http_status = http_status
        self.error_type = str(error_type or self.__class__.__name__)
        self.scope = scope
        super().__init__(f"雅仓 {stage} 失败: {message}")

    def diagnostic(self) -> dict[str, Any]:
        return {
            "error_code": self.code,
            "stage": self.stage,
            "http_status": self.http_status,
            "error_type": self.error_type,
            "error": str(self),
        }


__all__ = ["YacangError", "safe_remote_detail"]
