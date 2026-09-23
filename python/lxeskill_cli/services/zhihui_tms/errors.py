from __future__ import annotations

import json
import re
from collections.abc import Mapping, Sequence
from typing import Any


MAX_ERROR_TEXT_CHARS = 4_000
MAX_ERROR_MAPPING_ITEMS = 200
MAX_ERROR_SEQUENCE_ITEMS = 200
MAX_ERROR_NESTING_DEPTH = 10

_BEARER_PATTERN = re.compile(r"(?i)\bbearer\s+[a-z0-9._~+/=-]+")
_SENSITIVE_ASSIGNMENT_PATTERN = re.compile(
    r"(?i)([\"']?(?:authorization|cookie|j?sessionid|pwd|password|passwd|"
    r"api[-_]?token|access[-_]?token|refresh[-_]?token|token|secret)[\"']?\s*[:=]\s*)"
    r"([\"']?)([^\s,;}&\"']+)([\"']?)"
)


def _normalize_key(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", "_", str(value).strip().lower()).strip("_")


def _is_sensitive_key(value: Any) -> bool:
    key = _normalize_key(value)
    return (
        key in {
            "authorization",
            "cookie",
            "jsessionid",
            "pwd",
            "password",
            "passwd",
            "secret",
            "token",
            "apitoken",
            "accesstoken",
            "refreshtoken",
            "api_token",
            "access_token",
            "refresh_token",
        }
        or key.endswith(("_password", "_passwd", "_secret", "_token", "_cookie"))
    )


def _truncate_text(value: str, *, max_chars: int = MAX_ERROR_TEXT_CHARS) -> str:
    if len(value) <= max_chars:
        return value
    omitted = len(value) - max_chars
    marker = f"... [truncated {omitted} chars]"
    return f"{value[:max(0, max_chars - len(marker))]}{marker}"


def redact_text(value: Any, *, secrets: Sequence[str] = ()) -> str:
    text = str(value)
    for secret in sorted({str(item) for item in secrets if str(item)}, key=len, reverse=True):
        text = text.replace(secret, "[REDACTED]")
    text = _BEARER_PATTERN.sub("Bearer [REDACTED]", text)
    text = _SENSITIVE_ASSIGNMENT_PATTERN.sub(r"\1[REDACTED]", text)
    return _truncate_text(text)


def redact_value(
    value: Any,
    *,
    secrets: Sequence[str] = (),
    depth: int = 0,
) -> Any:
    if depth >= MAX_ERROR_NESTING_DEPTH:
        return f"[truncated at nesting depth {MAX_ERROR_NESTING_DEPTH}]"
    if isinstance(value, str):
        return redact_text(value, secrets=secrets)
    if isinstance(value, Mapping):
        items = list(value.items())
        result: dict[str, Any] = {}
        for raw_key, raw_value in items[:MAX_ERROR_MAPPING_ITEMS]:
            key = redact_text(raw_key, secrets=secrets,)
            result[key] = (
                "[REDACTED]"
                if _is_sensitive_key(raw_key)
                else redact_value(raw_value, secrets=secrets, depth=depth + 1)
            )
        if len(items) > MAX_ERROR_MAPPING_ITEMS:
            result["_truncated_mapping_items"] = len(items) - MAX_ERROR_MAPPING_ITEMS
        return result
    if isinstance(value, Sequence) and not isinstance(value, (bytes, bytearray, str)):
        items = list(value)
        result = [redact_value(item, secrets=secrets, depth=depth + 1) for item in items[:MAX_ERROR_SEQUENCE_ITEMS]]
        if len(items) > MAX_ERROR_SEQUENCE_ITEMS:
            result.append({"_truncated_sequence_items": len(items) - MAX_ERROR_SEQUENCE_ITEMS})
        return result
    if value is None or isinstance(value, (bool, int, float)):
        return value
    return redact_text(value, secrets=secrets)


class ZhihuiTmsError(RuntimeError):
    def __init__(
        self,
        code: str,
        message: str,
        *,
        http_status: int | None = None,
        payload: Any = None,
        secrets: Sequence[str] = (),
    ) -> None:
        self.code = redact_text(code, secrets=secrets,)
        self.http_status = http_status
        self.payload = redact_value(payload, secrets=secrets) if payload is not None else None
        safe_message = redact_text(message, secrets=secrets)
        super().__init__(safe_message)


class ZhihuiTmsConfigError(ZhihuiTmsError):
    pass


class ZhihuiTmsTransportError(ZhihuiTmsError):
    pass


class ZhihuiTmsHttpError(ZhihuiTmsError):
    pass


class ZhihuiTmsApiError(ZhihuiTmsError):
    pass


class ZhihuiTmsSchemaError(ZhihuiTmsError):
    pass


def safe_payload_text(value: Any, *, secrets: Sequence[str] = ()) -> str:
    sanitized = redact_value(value, secrets=secrets)
    if isinstance(sanitized, str):
        return sanitized
    return _truncate_text(json.dumps(sanitized, ensure_ascii=False, default=str))


__all__ = [
    "ZhihuiTmsApiError",
    "ZhihuiTmsConfigError",
    "ZhihuiTmsError",
    "ZhihuiTmsHttpError",
    "ZhihuiTmsSchemaError",
    "ZhihuiTmsTransportError",
    "redact_text",
    "redact_value",
    "safe_payload_text",
]
