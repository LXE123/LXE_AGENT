from __future__ import annotations

import os
from typing import Any, Mapping

import requests

from services.agent_cli._shared.json_cli import exception_text
from shared.infra.net import local_service_requests_session


DEFAULT_TIMEOUT_SECONDS = 30.0
MAX_REMOTE_BODY_CHARS = 4_000


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
        super().__init__(message)
        self.code = code
        self.http_status = http_status
        self.detail = dict(detail or {})
        self.payload = dict(payload or {})


def _timeout_seconds() -> float:
    raw = str(os.getenv("LXE_DATA_SERVER_REQUEST_TIMEOUT_SECONDS") or "").strip()
    if not raw:
        return DEFAULT_TIMEOUT_SECONDS
    try:
        value = float(raw)
    except ValueError as exc:
        raise ErpHttpError(
            "erp_environment_invalid",
            f"LXE_DATA_SERVER_REQUEST_TIMEOUT_SECONDS 格式无效: {raw}",
        ) from exc
    if value <= 0:
        raise ErpHttpError(
            "erp_environment_invalid",
            "LXE_DATA_SERVER_REQUEST_TIMEOUT_SECONDS 必须大于 0",
        )
    return value


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
    return base_url, api_key, _timeout_seconds()


def _safe_remote_body(response: Any) -> str:
    body = str(getattr(response, "text", "") or "")
    if len(body) <= MAX_REMOTE_BODY_CHARS:
        return body
    omitted = len(body) - MAX_REMOTE_BODY_CHARS
    return f"{body[:MAX_REMOTE_BODY_CHARS]}... [truncated {omitted} chars]"


def _response_json(response: Any) -> dict[str, Any]:
    try:
        payload = response.json()
    except Exception as exc:
        body = _safe_remote_body(response)
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
    return dict(payload)


def _remote_error(response: Any, payload: Mapping[str, Any]) -> ErpHttpError:
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
        or _safe_remote_body(response)
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
            f"连接 ERP 失败: {exception_text(exc)}",
        ) from exc

    payload = _response_json(response)
    status_code = int(response.status_code)
    if 200 <= status_code < 300:
        return status_code, payload
    error = _remote_error(response, payload)
    if error.code in accepted_error_codes:
        return status_code, payload
    raise error


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
    "request_json",
]
