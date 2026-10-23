"""Read-only Mabang data-service transport; credentials never come from browser cookies."""
from __future__ import annotations

import asyncio
import json
import math
import os
import re
import time
from contextlib import AsyncExitStack, asynccontextmanager, contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Any


from shared.infra.cloud_async import AsyncCloudClient
from shared.infra.cloud_client import CloudConnectionError
from .errors import MabangRequestError


@dataclass
class RequestMetrics:
    """Numbers only; scoped to one catalog phase and inherited by its existing workers."""
    batch_count: int = 0
    request_count: int = 0
    request_failure_count: int = 0
    request_cancelled_count: int = 0
    http_attempt_count: int = 0
    http_failure_count: int = 0
    retry_count: int = 0
    client_count: int = 0
    request_ms: float = 0
    http_ms: float = 0

    def summary(self) -> dict[str, int | float]:
        return {
            "batch_count": self.batch_count,
            "request_count": self.request_count,
            "request_failure_count": self.request_failure_count,
            "request_cancelled_count": self.request_cancelled_count,
            "http_attempt_count": self.http_attempt_count,
            "http_failure_count": self.http_failure_count,
            "retry_count": self.retry_count,
            "client_count": self.client_count,
            "total_request_ms": round(self.request_ms, 3),
            "average_request_ms": round(self.request_ms / self.request_count, 3) if self.request_count else 0,
            "total_http_ms": round(self.http_ms, 3),
        }


_REQUEST_METRICS: ContextVar[RequestMetrics | None] = ContextVar("mabang_request_metrics", default=None)


@dataclass
class _CatalogClientScope:
    stack: AsyncExitStack
    client: AsyncCloudClient | None = None
    base: str | None = None
    active: bool = True


_CATALOG_CLIENT: ContextVar[_CatalogClientScope | None] = ContextVar("mabang_catalog_client", default=None)


@asynccontextmanager
async def catalog_client_scope():
    """One verification owns its client; its existing workers may borrow it until cleanup."""
    async with AsyncExitStack() as stack:
        scope = _CatalogClientScope(stack)
        token = _CATALOG_CLIENT.set(scope)
        try:
            yield
        finally:
            scope.active = False
            _CATALOG_CLIENT.reset(token)


@contextmanager
def observe_requests(metrics: RequestMetrics):
    token = _REQUEST_METRICS.set(metrics)
    try:
        yield
    finally:
        _REQUEST_METRICS.reset(token)

REQUEST_TIMEOUT_SECONDS = 60
MAX_ATTEMPTS = 3
ROOT = "/api/v1/data-sources/mabang/"
_SENSITIVE = re.compile(r"(?i)authorization|cookie|password|passwd|secret|token|api.?key|app.?key|signature|^sign$")
_QUOTED_SECRET = re.compile(
    r'''(?i)((?:authorization|cookie|password|passwd|secret|token|api[_-]?key|app[_-]?key|signature)["']?\s*[:=]\s*)(["'])(.*?)(\2)'''
)


def diagnostic(value: Any) -> str:
    def clean(item: Any) -> Any:
        if isinstance(item, dict):
            return {str(k): "[REDACTED]" if _SENSITIVE.search(str(k)) else clean(v) for k, v in item.items()}
        if isinstance(item, list):
            return [clean(v) for v in item]
        return item

    result = value if isinstance(value, str) else json.dumps(clean(value), ensure_ascii=False, default=str)
    for name in ("LXE_DATA_SERVER_API_KEY", "LXE_DATA_SERVER_FALLBACK_API_KEY", "LXE_ERP_API_KEY"):
        secret = os.getenv(name, "").strip()
        if secret:
            result = result.replace(secret, "[REDACTED]")
    result = re.sub(r"(?i)\bBearer\s+[a-z0-9._~+/=-]+", "Bearer [REDACTED]", result)
    result = _QUOTED_SECRET.sub(r"\1[REDACTED]", result)
    result = re.sub(r'''(?i)((?:authorization|cookie|password|passwd|secret|token|api[_-]?key|signature)["']?\s*[:=]\s*)["']?[^\s,;}"']+''', r"\1[REDACTED]", result)
    if len(result) > 4000:
        result = result[:3800] + f"... [truncated {len(result) - 3800} chars]"
    return result


class OfficialApiError(MabangRequestError):
    def __init__(self, context: str, reason: str, payload: Any = None) -> None:
        super().__init__(diagnostic(f"{context}: {reason}") + (f"; response={diagnostic(payload)}" if payload is not None else ""))


def invalid(context: str, reason: str, payload: Any) -> None:
    raise OfficialApiError(context, reason, payload)


def retry_delay(value: str | None, fallback: float) -> float:
    if not value:
        return fallback
    try:
        seconds = float(value)
    except ValueError:
        try:
            date = parsedate_to_datetime(value)
            if date.tzinfo is None:
                date = date.replace(tzinfo=timezone.utc)
            seconds = (date - datetime.now(timezone.utc)).total_seconds()
        except (ValueError, TypeError, OverflowError):
            return fallback
    return max(0.0, seconds) if math.isfinite(seconds) and seconds >= 0 else fallback


def _business_failure(payload: Any) -> bool:
    if not isinstance(payload, dict):
        return False
    if "code" in payload and str(payload["code"]) != "200":
        return True
    return any(_business_failure(payload.get(key)) for key in ("detail", "upstream", "body"))


async def post_json(endpoint: str, body: dict[str, Any], *, context: str) -> dict[str, Any]:
    metrics = _REQUEST_METRICS.get()
    if metrics is None:
        return await _post_json(endpoint, body, context=context)
    metrics.request_count += 1
    started = time.perf_counter()
    try:
        return await _post_json(endpoint, body, context=context)
    except asyncio.CancelledError:
        metrics.request_cancelled_count += 1
        raise
    except Exception:
        metrics.request_failure_count += 1
        raise
    finally:
        metrics.request_ms += (time.perf_counter() - started) * 1000


async def _request_json(client, endpoint: str, body: dict[str, Any], metrics: RequestMetrics | None):
    if metrics is None:
        return await client.request_json("POST", ROOT + endpoint, json_body=body)
    metrics.http_attempt_count += 1
    started = time.perf_counter()
    try:
        response = await client.request_json("POST", ROOT + endpoint, json_body=body)
    except Exception:
        metrics.http_failure_count += 1
        raise
    else:
        if not (200 <= response.status_code < 300 and isinstance(response.payload, dict)
                and str(response.payload.get("code")) == "200"):
            metrics.http_failure_count += 1
        return response
    finally:
        metrics.http_ms += (time.perf_counter() - started) * 1000


async def _post_json(endpoint: str, body: dict[str, Any], *, context: str) -> dict[str, Any]:
    metrics = _REQUEST_METRICS.get()
    base = os.getenv("LXE_DATA_SERVER_URL", "").strip().rstrip("/")
    if not base:
        raise OfficialApiError(context, "LXE_DATA_SERVER_URL 未配置")
    scope = _CATALOG_CLIENT.get()
    if (scope is not None and scope.active and endpoint in {"stock-skus/search", "combo-skus/search"}
            and scope.base in (None, base)):
        # The stock-first flow opens the client before launching combo workers.
        if scope.client is None:
            client = _new_client(base, context, metrics)
            scope.client = await scope.stack.enter_async_context(client)
            scope.base = base
        return await _post_with_client(scope.client, endpoint, body, context=context, metrics=metrics)
    client = _new_client(base, context, metrics)
    async with client:
        return await _post_with_client(client, endpoint, body, context=context, metrics=metrics)


def _new_client(base: str, context: str, metrics: RequestMetrics | None):
    try:
        client = AsyncCloudClient(base, timeout=REQUEST_TIMEOUT_SECONDS, max_response_bytes=None)
    except ValueError as exc:
        raise OfficialApiError(context, str(exc)) from exc
    if metrics is not None:
        metrics.client_count += 1
    return client


async def _post_with_client(client, endpoint: str, body: dict[str, Any], *, context: str,
                            metrics: RequestMetrics | None) -> dict[str, Any]:
    for attempt in range(MAX_ATTEMPTS):
        if metrics is not None and attempt:
            metrics.retry_count += 1
        try:
            response = await _request_json(client, endpoint, body, metrics)
        except CloudConnectionError as exc:
            if exc.retryable and attempt + 1 < MAX_ATTEMPTS:
                await asyncio.sleep(2 ** attempt)
                continue
            raise OfficialApiError(context, str(exc)) from exc
        except ValueError as exc:
            raise OfficialApiError(context, str(exc)) from exc
        status, payload = response.status_code, response.payload
        retry_after = response.headers.get("Retry-After")
        retryable = status in (429, 502, 503, 504) and not _business_failure(payload)
        if retryable and attempt + 1 < MAX_ATTEMPTS:
            await asyncio.sleep(retry_delay(retry_after, 2 ** attempt) if status == 429 else 2 ** attempt)
            continue
        if not 200 <= status < 300:
            raise OfficialApiError(context, f"HTTP {status}", payload)
        if not isinstance(payload, dict) or str(payload.get("code")) != "200":
            raise OfficialApiError(context, f"HTTP {status}: 无效 JSON 或业务失败", payload)
        return payload
    raise AssertionError("unreachable")
