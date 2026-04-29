from __future__ import annotations

from typing import Any
from urllib.parse import quote

import aiohttp

from shared.config import config
from shared.infra.net import external_http_session


class LogisticsApiError(RuntimeError):
    pass


def _base_url() -> str:
    value = str(getattr(config, "LOGISTICS_API_BASE_URL", "") or "").strip().rstrip("/")
    if not value:
        raise LogisticsApiError("LOGISTICS_API_BASE_URL is not configured")
    return value


def _timeout() -> aiohttp.ClientTimeout:
    seconds = max(1, int(getattr(config, "LOGISTICS_API_TIMEOUT_SECONDS", 30) or 30))
    return aiohttp.ClientTimeout(total=seconds)


def _headers() -> dict[str, str]:
    headers = {"Accept": "application/json"}
    api_key = str(getattr(config, "LOGISTICS_API_KEY", "") or "").strip()
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    return headers


def _endpoint(path: str) -> str:
    return f"{_base_url()}/{str(path or '').lstrip('/')}"


def _payload_error(payload: dict[str, Any]) -> str:
    for key in ("error", "message", "exception", "detail"):
        value = str(payload.get(key) or "").strip()
        if value:
            return value
    return str(payload)


async def _request_json(method: str, path: str, *, json_body: dict[str, Any] | None = None) -> dict[str, Any]:
    url = _endpoint(path)
    request = external_http_session.request(
        method,
        url,
        json=json_body,
        headers=_headers(),
        timeout=_timeout(),
    )
    async with request as response:
        text = await response.text()
        try:
            payload = await response.json(content_type=None)
        except Exception as exc:
            preview = text[:300] if text else "empty response"
            raise LogisticsApiError(
                f"Logistics API returned non-JSON response: status={response.status}, body={preview}"
            ) from exc

        if not isinstance(payload, dict):
            raise LogisticsApiError(f"Logistics API returned invalid JSON payload: {payload!r}")
        if response.status < 200 or response.status >= 300:
            raise LogisticsApiError(
                _payload_error(payload) or f"Logistics API request failed: status={response.status}"
            )
        if payload.get("ok") is False:
            raise LogisticsApiError(_payload_error(payload))
        return payload


async def create_import_job(file_path: str) -> dict[str, Any]:
    safe_file_path = str(file_path or "").strip()
    if not safe_file_path:
        raise LogisticsApiError("file_path is required")
    payload = await _request_json(
        "POST",
        "/api/v1/pricing/import-jobs",
        json_body={"file_path": safe_file_path},
    )
    if not str(payload.get("job_id") or "").strip():
        raise LogisticsApiError("Logistics API import job response missing job_id")
    return payload


async def get_import_job(job_id: str) -> dict[str, Any]:
    safe_job_id = str(job_id or "").strip()
    if not safe_job_id:
        raise LogisticsApiError("job_id is required")
    return await _request_json(
        "GET",
        f"/api/v1/pricing/import-jobs/{quote(safe_job_id, safe='')}",
    )


async def quote_pricing(payload: dict[str, Any]) -> dict[str, Any]:
    response = await _request_json(
        "POST",
        "/api/v1/pricing/quote",
        json_body=dict(payload or {}),
    )
    if response.get("ok") is not True:
        raise LogisticsApiError(
            _payload_error(response) or "Logistics API quote response missing ok=true"
        )
    return response


__all__ = [
    "LogisticsApiError",
    "create_import_job",
    "get_import_job",
    "quote_pricing",
]
