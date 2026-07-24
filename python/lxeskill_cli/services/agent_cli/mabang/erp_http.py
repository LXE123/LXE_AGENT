from __future__ import annotations

import os
import re
from collections.abc import Sequence
from typing import Any, Mapping

import requests

from services.agent_cli._shared.json_cli import exception_text
from shared.infra.net import local_service_requests_session


ERP_REQUEST_TIMEOUT_SECONDS = 30.0
MAX_REMOTE_BODY_CHARS = 4_000
MAX_REMOTE_VALUE_CHARS = 4_000
MAX_REMOTE_MAPPING_ITEMS = 500
MAX_REMOTE_SEQUENCE_ITEMS = 1_000
MAX_REMOTE_NESTING_DEPTH = 12

_BEARER_PATTERN = re.compile(r"(?i)\bbearer\s+[a-z0-9._~+/=-]+")
_SENSITIVE_QUOTED_VALUE_PATTERN = re.compile(
    r"(?i)([\"']?(?:authorization|x[-_]?api[-_]?key|api[-_]?key|"
    r"access[-_]?token|refresh[-_]?token|token|password|passwd|secret)"
    r"[\"']?\s*[:=]\s*)([\"'])(.*?)(\2)"
)
_AUTHORIZATION_PATTERN = re.compile(
    r"(?i)([\"']?authorization[\"']?\s*[:=]\s*)([\"']?)"
    r"(?:(?:bearer|basic)\s+)?([^\s,;}&\"']+)([\"']?)"
)
_SENSITIVE_VALUE_PATTERN = re.compile(
    r"(?i)([\"']?(?:x[-_]?api[-_]?key|api[-_]?key|access[-_]?token|"
    r"refresh[-_]?token|token|password|passwd|secret)[\"']?\s*[:=]\s*)"
    r"([\"']?)([^\s,;}&\"']+)([\"']?)"
)


class ErpHttpError(RuntimeError):
    def __init__(
        self,
        code: str,
        message: str,
        *,
        http_status: int | None = None,
        detail: Mapping[str, Any] | None = None,
        payload: Mapping[str, Any] | None = None,
    ) -> None:
        secrets = _configured_secrets()
        super().__init__(_safe_text(message, secrets=secrets))
        self.code = _safe_text(code, secrets=secrets, max_chars=256)
        self.http_status = http_status
        safe_detail = _sanitize_value(detail or {}, secrets=secrets)
        safe_payload = _sanitize_value(payload or {}, secrets=secrets)
        self.detail = dict(safe_detail) if isinstance(safe_detail, Mapping) else {}
        self.payload = dict(safe_payload) if isinstance(safe_payload, Mapping) else {}


def _configured_secrets() -> tuple[str, ...]:
    api_key = str(os.getenv("LXE_ERP_API_KEY") or "").strip()
    return (api_key,) if api_key else ()


def _truncate_text(value: str, *, max_chars: int) -> str:
    if len(value) <= max_chars:
        return value
    omitted = len(value) - max_chars
    marker = f"... [truncated {omitted} chars]"
    visible_chars = max(0, max_chars - len(marker))
    return f"{value[:visible_chars]}{marker}"


def _redact_text(value: str, *, secrets: Sequence[str]) -> str:
    redacted = value
    for secret in sorted({item for item in secrets if item}, key=len, reverse=True):
        redacted = redacted.replace(secret, "[REDACTED]")
    redacted = _SENSITIVE_QUOTED_VALUE_PATTERN.sub(r"\1[REDACTED]", redacted)
    redacted = _BEARER_PATTERN.sub("Bearer [REDACTED]", redacted)
    redacted = _AUTHORIZATION_PATTERN.sub(r"\1[REDACTED]", redacted)
    redacted = _SENSITIVE_VALUE_PATTERN.sub(r"\1[REDACTED]", redacted)
    return redacted


def _safe_text(
    value: Any,
    *,
    secrets: Sequence[str] = (),
    max_chars: int = MAX_REMOTE_VALUE_CHARS,
) -> str:
    return _truncate_text(_redact_text(str(value), secrets=secrets), max_chars=max_chars)


def _is_sensitive_key(value: Any) -> bool:
    normalized = re.sub(r"[^a-z0-9]+", "_", str(value).strip().lower()).strip("_")
    return (
        normalized in {"authorization", "password", "passwd", "secret"}
        or normalized.endswith("_password")
        or normalized.endswith("_passwd")
        or normalized.endswith("_secret")
        or normalized == "token"
        or normalized.endswith("_token")
        or normalized == "api_key"
        or normalized.endswith("_api_key")
    )


def _sanitize_value(
    value: Any,
    *,
    secrets: Sequence[str],
    depth: int = 0,
    bounded: bool = True,
) -> Any:
    if bounded and depth >= MAX_REMOTE_NESTING_DEPTH:
        return f"[truncated at nesting depth {MAX_REMOTE_NESTING_DEPTH}]"
    if isinstance(value, str):
        return (
            _safe_text(value, secrets=secrets)
            if bounded
            else _redact_text(value, secrets=secrets)
        )
    if isinstance(value, Mapping):
        result: dict[str, Any] = {}
        existing_omitted = 0
        items = list(value.items())
        if bounded:
            marker = value.get("_truncated_mapping_items")
            if isinstance(marker, int) and marker > 0:
                existing_omitted = marker
                items = [
                    (raw_key, raw_value)
                    for raw_key, raw_value in items
                    if raw_key != "_truncated_mapping_items"
                ]
        selected_items = items[:MAX_REMOTE_MAPPING_ITEMS] if bounded else items
        for raw_key, raw_value in selected_items:
            key = (
                _safe_text(raw_key, secrets=secrets, max_chars=256)
                if bounded
                else _redact_text(str(raw_key), secrets=secrets)
            )
            if _is_sensitive_key(raw_key):
                result[key] = "[REDACTED]"
            else:
                result[key] = _sanitize_value(
                    raw_value,
                    secrets=secrets,
                    depth=depth + 1,
                    bounded=bounded,
                )
        omitted = len(items) - len(selected_items) + existing_omitted
        if bounded and omitted > 0:
            result["_truncated_mapping_items"] = omitted
        return result
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        existing_omitted = 0
        values = list(value)
        if bounded and values and isinstance(values[-1], Mapping):
            marker = values[-1].get("_truncated_sequence_items")
            if isinstance(marker, int) and marker > 0:
                existing_omitted = marker
                values = values[:-1]
        selected_values = values[:MAX_REMOTE_SEQUENCE_ITEMS] if bounded else values
        result = [
            _sanitize_value(
                item,
                secrets=secrets,
                depth=depth + 1,
                bounded=bounded,
            )
            for item in selected_values
        ]
        omitted = len(values) - len(selected_values) + existing_omitted
        if bounded and omitted > 0:
            result.append({"_truncated_sequence_items": omitted})
        return result
    if value is None or isinstance(value, (bool, int, float)):
        return value
    return (
        _safe_text(value, secrets=secrets)
        if bounded
        else _redact_text(str(value), secrets=secrets)
    )


def connection_settings(*, operation: str) -> tuple[str, str, float]:
    base_url = str(os.getenv("LXE_DATA_SERVER_URL") or "").strip().rstrip("/")
    if not base_url:
        raise ErpHttpError(
            "erp_server_not_configured",
            f"LXE_DATA_SERVER_URL 未配置，无法{operation}",
        )
    api_key = str(os.getenv("LXE_ERP_API_KEY") or "").strip()
    if not api_key:
        raise ErpHttpError(
            "erp_credentials_not_configured",
            f"LXE_ERP_API_KEY 未配置，无法{operation}",
        )
    return base_url, api_key, ERP_REQUEST_TIMEOUT_SECONDS


def _safe_remote_body(response: Any, *, secrets: Sequence[str]) -> str:
    body = str(getattr(response, "text", "") or "")
    return _safe_text(body, secrets=secrets, max_chars=MAX_REMOTE_BODY_CHARS)


def _response_json(
    response: Any,
    *,
    secrets: Sequence[str],
    bounded: bool | None = None,
) -> dict[str, Any]:
    try:
        payload = response.json()
    except Exception as exc:
        body = _safe_remote_body(response, secrets=secrets)
        raise ErpHttpError(
            "erp_response_invalid",
            f"ERP 返回了无法解析的 JSON: HTTP {response.status_code}, body={body}",
            http_status=int(response.status_code),
        ) from exc
    if not isinstance(payload, dict):
        raise ErpHttpError(
            "erp_response_invalid",
            f"ERP 返回 JSON 不是对象: HTTP {response.status_code}",
            http_status=int(response.status_code),
        )
    status_code = int(response.status_code)
    sanitized = _sanitize_value(
        payload,
        secrets=secrets,
        bounded=(not (200 <= status_code < 300)) if bounded is None else bounded,
    )
    if not isinstance(sanitized, Mapping):
        raise ErpHttpError(
            "erp_response_invalid",
            f"ERP 返回 JSON 不是对象: HTTP {response.status_code}",
            http_status=int(response.status_code),
        )
    return dict(sanitized)


def _remote_error(
    response: Any,
    payload: Mapping[str, Any],
    *,
    secrets: Sequence[str],
) -> ErpHttpError:
    raw_detail = payload.get("detail")
    raw_error = payload.get("error")
    detail = dict(raw_detail) if isinstance(raw_detail, dict) else {}
    top_error = dict(raw_error) if isinstance(raw_error, dict) else {}
    error_fields = detail or top_error
    code = str(error_fields.get("code") or f"erp_http_{response.status_code}")
    message = str(
        error_fields.get("message")
        or raw_detail
        or raw_error
        or _safe_remote_body(response, secrets=secrets)
        or f"ERP 请求失败: HTTP {response.status_code}"
    )
    return ErpHttpError(
        code,
        message,
        http_status=int(response.status_code),
        detail=error_fields,
        payload=payload,
    )


def request_json(
    method: str,
    path: str,
    *,
    operation: str,
    json_payload: Mapping[str, Any] | None = None,
    accepted_error_codes: frozenset[str] = frozenset(),
) -> tuple[int, dict[str, Any]]:
    base_url, api_key, timeout = connection_settings(operation=operation)
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    try:
        response = local_service_requests_session.request(
            method,
            f"{base_url}{path}",
            headers=headers,
            json=dict(json_payload) if json_payload is not None else None,
            timeout=timeout,
        )
    except requests.RequestException as exc:
        raise ErpHttpError(
            "erp_transport_error",
            f"连接 ERP 失败: {_safe_text(exception_text(exc), secrets=(api_key,))}",
        ) from exc

    status_code = int(response.status_code)
    if 200 <= status_code < 300:
        payload = _response_json(response, secrets=(api_key,), bounded=False)
        return status_code, payload
    payload = _response_json(response, secrets=(api_key,), bounded=True)
    error = _remote_error(response, payload, secrets=(api_key,))
    if error.code in accepted_error_codes:
        return status_code, _response_json(
            response,
            secrets=(api_key,),
            bounded=False,
        )
    raise error


def request_bytes(
    method: str,
    path: str,
    *,
    operation: str,
    accepted_status_codes: frozenset[int] = frozenset({200}),
) -> tuple[int, bytes, Mapping[str, str]]:
    base_url, api_key, timeout = connection_settings(operation=operation)
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Accept": (
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, "
            "application/octet-stream, application/json"
        ),
    }
    try:
        response = local_service_requests_session.request(
            method,
            f"{base_url}{path}",
            headers=headers,
            timeout=timeout,
        )
    except requests.RequestException as exc:
        raise ErpHttpError(
            "erp_transport_error",
            f"连接 ERP 失败: {_safe_text(exception_text(exc), secrets=(api_key,))}",
        ) from exc

    status_code = int(response.status_code)
    if status_code not in accepted_status_codes:
        payload = _response_json(response, secrets=(api_key,))
        raise _remote_error(response, payload, secrets=(api_key,))

    content = bytes(getattr(response, "content", b"") or b"")
    raw_headers = getattr(response, "headers", {}) or {}
    safe_headers = {
        _safe_text(key, secrets=(api_key,), max_chars=256): _safe_text(
            value,
            secrets=(api_key,),
        )
        for key, value in raw_headers.items()
    }
    return status_code, content, safe_headers


def error_payload(exc: ErpHttpError) -> dict[str, Any]:
    error: dict[str, Any] = {"code": exc.code, "message": str(exc)}
    if exc.http_status is not None:
        error["http_status"] = exc.http_status
    if exc.detail:
        error["detail"] = exc.detail
    return error


__all__ = [
    "ErpHttpError",
    "connection_settings",
    "error_payload",
    "request_bytes",
    "request_json",
]
