from __future__ import annotations

import io
import math
import random
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any
from urllib.parse import urlsplit
from zipfile import is_zipfile

import requests

from .errors import (
    ZhihuiTmsApiError,
    ZhihuiTmsConfigError,
    ZhihuiTmsHttpError,
    ZhihuiTmsSchemaError,
    ZhihuiTmsTransportError,
)
from .schemas import LoginResult, parse_login_response


DEFAULT_BASE_URL = "https://tms.mabangerp.com/tmsapi"
DEFAULT_TIMEOUT: tuple[float, float] = (5.0, 30.0)
DEFAULT_MIN_REQUEST_INTERVAL_SECONDS = 2.0
DEFAULT_MAX_HTTP_ATTEMPTS = 400
DEFAULT_MAX_DOWNLOAD_BYTES = 50_000_000
DEFAULT_DOWNLOAD_HOSTS = ("tms-cos.mabangerp.com",)
RETRYABLE_STATUS_CODES = frozenset({408, 429, 500, 502, 503, 504})
_XLS_SIGNATURE = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"
_ALLOWED_DOWNLOAD_MIME_TYPES = frozenset(
    {
        "application/octet-stream",
        "application/vnd.ms-excel",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }
)


@dataclass(frozen=True)
class RetryPolicy:
    max_attempts: int = 3
    backoff_seconds: float = 1.0
    jitter_ratio: float = 0.25
    retryable_status_codes: frozenset[int] = field(default_factory=lambda: RETRYABLE_STATUS_CODES)

    def __post_init__(self) -> None:
        if self.max_attempts < 1 or self.max_attempts > 10:
            raise ValueError("max_attempts must be between 1 and 10")
        if self.backoff_seconds < 0:
            raise ValueError("backoff_seconds must not be negative")
        if not 0 <= self.jitter_ratio <= 1:
            raise ValueError("jitter_ratio must be between 0 and 1")

    def delay(self, attempt: int, *, random_fn: Callable[[], float]) -> float:
        base = self.backoff_seconds * (2 ** max(0, attempt - 1))
        if self.jitter_ratio == 0:
            return base
        jitter = (random_fn() * 2 - 1) * self.jitter_ratio
        return max(0.0, base * (1 + jitter))


class ZhihuiTmsClient:
    def __init__(
        self,
        *,
        base_url: str = DEFAULT_BASE_URL,
        session: requests.Session | Any | None = None,
        timeout: tuple[float, float] = DEFAULT_TIMEOUT,
        retry_policy: RetryPolicy | None = None,
        sleeper: Callable[[float], None] = time.sleep,
        random_fn: Callable[[], float] = random.random,
        clock: Callable[[], float] = time.monotonic,
        min_request_interval_seconds: float = DEFAULT_MIN_REQUEST_INTERVAL_SECONDS,
        max_http_attempts: int = DEFAULT_MAX_HTTP_ATTEMPTS,
        api_token: str = "",
    ) -> None:
        normalized_base_url = str(base_url or "").strip().rstrip("/")
        if not normalized_base_url.startswith(("https://", "http://")):
            raise ZhihuiTmsConfigError(
                "tms_base_url_invalid",
                "智汇 TMS base URL 必须使用 HTTP(S) 协议",
            )
        if len(timeout) != 2 or any(float(value) <= 0 for value in timeout):
            raise ZhihuiTmsConfigError(
                "tms_timeout_invalid",
                "智汇 TMS timeout 必须包含正数 connect/read 值",
            )
        if (
            isinstance(min_request_interval_seconds, bool)
            or not isinstance(min_request_interval_seconds, (int, float))
            or not math.isfinite(min_request_interval_seconds)
            or min_request_interval_seconds < 0
        ):
            raise ZhihuiTmsConfigError(
                "tms_request_interval_invalid",
                "智汇 TMS 请求最小间隔必须是非负有限秒数",
            )
        if isinstance(max_http_attempts, bool) or not isinstance(max_http_attempts, int) or max_http_attempts < 1:
            raise ZhihuiTmsConfigError(
                "tms_http_attempt_limit_invalid",
                "智汇 TMS HTTP 请求尝试次数上限必须是正整数",
            )
        self.base_url = normalized_base_url
        self.session = session or requests.Session()
        self.timeout = (float(timeout[0]), float(timeout[1]))
        self.retry_policy = retry_policy or RetryPolicy()
        self._sleeper = sleeper
        self._random_fn = random_fn
        self._clock = clock
        self.min_request_interval_seconds = float(min_request_interval_seconds)
        self._last_request_started: float | None = None
        self.max_http_attempts = max_http_attempts
        self._request_attempt_count = 0
        self._api_token = str(api_token or "")
        self._authentication_recovery: Callable[[], None] | None = None
        self._authentication_recovery_attempted = False

    @property
    def request_attempt_count(self) -> int:
        return self._request_attempt_count

    @property
    def api_token(self) -> str:
        """Return the in-memory token for authenticated follow-up requests."""

        return self._api_token

    def set_authentication_recovery(self, callback: Callable[[], None]) -> None:
        """Register the one-shot recovery used only after an explicit HTTP 401."""

        self._authentication_recovery = callback

    def login(
        self,
        username: str,
        password: str,
        *,
        local_time: str | None = None,
    ) -> LoginResult:
        safe_username = str(username or "").strip()
        if not safe_username or not str(password):
            raise ZhihuiTmsConfigError(
                "tms_credentials_missing",
                "智汇 TMS 登录账号和密码不能为空",
            )
        payload = {
            "userName": safe_username,
            "pwd": str(password),
            "local_time": local_time or datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        }
        response_payload = self._post_json(
            "/login",
            payload,
            operation="智汇 TMS 登录",
            login=True,
            secrets=(safe_username, str(password)),
        )
        result = parse_login_response(
            response_payload,
            http_status=200,
            secrets=(safe_username, str(password)),
        )
        self._api_token = result.api_token
        return result

    def post_json(
        self,
        path: str,
        payload: Mapping[str, Any],
        *,
        operation: str,
    ) -> dict[str, Any]:
        if not self._api_token:
            raise ZhihuiTmsConfigError(
                "tms_not_authenticated",
                f"{operation} 需要先完成智汇 TMS 登录",
            )
        return self._post_json(
            path,
            payload,
            operation=operation,
            login=False,
            secrets=(self._api_token,),
        )

    def find_my_stockwarehouse_list(self, *, page: int) -> dict[str, Any]:
        if isinstance(page, bool) or not isinstance(page, int) or page < 1:
            raise ValueError("智汇 TMS 商品列表页码必须是正整数")
        return self.post_json(
            "/findMyStockwarehouseList",
            {
                "page": page,
                "pageSize": 1000,
                "isConfirm": 1,
                "classId": None,
                "orderBys": "2",
                "status": 1,
                "gridproperty": -1,
                "if_produce": "-1",
                "providerId": "",
                "stockQuantity": -1,
            },
            operation="智汇 TMS 商品列表",
        )

    def export_stockwarehouse(self, product_ids: Sequence[Any]) -> dict[str, Any]:
        if isinstance(product_ids, (str, bytes, bytearray)) or not product_ids:
            raise ValueError("智汇 TMS 商品导出至少需要一个商品 ID")
        return self.post_json(
            "/exportStockwarehouse",
            {
                "startNum": None,
                "pageSize": 1000,
                "classId": None,
                "gridproperty": -1,
                "idsList": list(product_ids),
                "isCombo": 1,
                "ischecked": False,
                "orderBys": "2",
                "status": 1,
                "stockValueArr": [
                    "stockSku",
                    "sale3",
                    "sale1",
                    "availableinventory",
                    "sale2",
                    "warehouse",
                    "stockQuantity",
                    "allotShippingQuantity",
                    "stockCost",
                    "purchasePrice",
                    "lastInTime",
                    "sale5",
                ],
            },
            operation="智汇 TMS 商品分页导出",
        )

    def download_bytes(
        self,
        url: str,
        *,
        allowed_hosts: Sequence[str] = DEFAULT_DOWNLOAD_HOSTS,
        max_bytes: int = DEFAULT_MAX_DOWNLOAD_BYTES,
        operation: str = "智汇 TMS 文件下载",
    ) -> tuple[bytes, str]:
        parsed = urlsplit(str(url or "").strip())
        if parsed.scheme.lower() != "https":
            raise ZhihuiTmsConfigError(
                "tms_download_url_invalid",
                f"{operation} 只允许 HTTPS 下载地址",
            )
        if parsed.username or parsed.password or parsed.port not in (None, 443):
            raise ZhihuiTmsConfigError(
                "tms_download_url_invalid",
                f"{operation} 下载地址不能包含用户信息或非标准端口",
            )
        host = (parsed.hostname or "").lower().rstrip(".")
        trusted_hosts = {str(item).strip().lower().rstrip(".") for item in allowed_hosts if str(item).strip()}
        if not host or host not in trusted_hosts:
            raise ZhihuiTmsConfigError(
                "tms_download_host_untrusted",
                f"{operation} 下载地址不属于可信域名",
            )
        if isinstance(max_bytes, bool) or not isinstance(max_bytes, int) or max_bytes < 1:
            raise ZhihuiTmsConfigError(
                "tms_download_size_invalid",
                f"{operation} max_bytes 必须是正整数",
            )

        headers = {
            "Accept": ", ".join(sorted(_ALLOWED_DOWNLOAD_MIME_TYPES)),
        }
        secrets = (self._api_token,)
        for attempt in range(1, self.retry_policy.max_attempts + 1):
            self._pace_request()
            try:
                response = self.session.request(
                    "GET",
                    str(url).strip(),
                    headers=headers,
                    timeout=self.timeout,
                    allow_redirects=False,
                    stream=True,
                )
            except (requests.Timeout, requests.ConnectionError) as exc:
                if attempt < self.retry_policy.max_attempts:
                    self._sleep_for_retry(attempt)
                    continue
                raise ZhihuiTmsTransportError(
                    "tms_download_transport_error",
                    f"{operation} 网络请求失败: {exc}",
                    secrets=secrets,
                ) from exc
            except requests.RequestException as exc:
                raise ZhihuiTmsTransportError(
                    "tms_download_transport_error",
                    f"{operation} HTTP 客户端失败: {exc}",
                    secrets=secrets,
                ) from exc

            status_code = int(response.status_code)
            if (
                status_code != 429
                and status_code in self.retry_policy.retryable_status_codes
                and attempt < self.retry_policy.max_attempts
            ):
                self._close_response(response)
                self._sleep_for_retry(attempt, retry_after=response.headers.get("Retry-After"))
                continue
            if not 200 <= status_code < 300:
                body = str(getattr(response, "text", "") or "")
                self._close_response(response)
                raise ZhihuiTmsHttpError(
                    f"tms_download_http_{status_code}",
                    f"{operation} HTTP {status_code}: {body}",
                    http_status=status_code,
                    secrets=secrets,
                )

            content_type = str(response.headers.get("Content-Type", "")).split(";", 1)[0].strip().lower()
            if content_type not in _ALLOWED_DOWNLOAD_MIME_TYPES:
                self._close_response(response)
                raise ZhihuiTmsSchemaError(
                    "tms_download_mime_invalid",
                    f"{operation} 响应 MIME 不支持: {content_type or '<missing>'}",
                    http_status=status_code,
                    secrets=secrets,
                )
            raw_length = response.headers.get("Content-Length")
            try:
                declared_length = int(raw_length) if raw_length is not None else None
            except (TypeError, ValueError):
                declared_length = None
            if declared_length is not None and declared_length > max_bytes:
                self._close_response(response)
                raise ZhihuiTmsSchemaError(
                    "tms_download_size_exceeded",
                    f"{operation} 响应大小超过上限: {declared_length} > {max_bytes}",
                    http_status=status_code,
                    secrets=secrets,
                )

            chunks: list[bytes] = []
            total_size = 0
            try:
                for chunk in response.iter_content(chunk_size=64 * 1024):
                    if not chunk:
                        continue
                    total_size += len(chunk)
                    if total_size > max_bytes:
                        raise ZhihuiTmsSchemaError(
                            "tms_download_size_exceeded",
                            f"{operation} 响应大小超过上限: {total_size} > {max_bytes}",
                            http_status=status_code,
                            secrets=secrets,
                        )
                    chunks.append(bytes(chunk))
            except (
                requests.Timeout,
                requests.ConnectionError,
                requests.exceptions.ChunkedEncodingError,
            ) as exc:
                if attempt < self.retry_policy.max_attempts:
                    self._sleep_for_retry(attempt)
                    continue
                raise ZhihuiTmsTransportError(
                    "tms_download_transport_error",
                    f"{operation} 读取文件失败: {exc}",
                    secrets=secrets,
                ) from exc
            finally:
                self._close_response(response)
            content = b"".join(chunks)
            if content.startswith(_XLS_SIGNATURE):
                return content, content_type
            if is_zipfile(io.BytesIO(content)):
                return content, content_type
            raise ZhihuiTmsSchemaError(
                "tms_download_signature_invalid",
                f"{operation} 文件头不是有效的 XLS/XLSX",
                http_status=status_code,
                secrets=secrets,
            )
        raise AssertionError("unreachable")

    @staticmethod
    def _close_response(response: Any) -> None:
        close = getattr(response, "close", None)
        if callable(close):
            close()

    def _pace_request(self) -> None:
        if self._request_attempt_count >= self.max_http_attempts:
            raise ZhihuiTmsConfigError(
                "tms_http_attempt_limit",
                f"智汇 TMS HTTP 请求尝试次数达到上限: {self.max_http_attempts}",
            )
        now = self._clock()
        if self._last_request_started is not None:
            remaining = self.min_request_interval_seconds - (now - self._last_request_started)
            if remaining > 0:
                self._sleeper(remaining)
                now = self._clock()
        self._last_request_started = now
        self._request_attempt_count += 1

    def _post_json(
        self,
        path: str,
        payload: Mapping[str, Any],
        *,
        operation: str,
        login: bool,
        secrets: tuple[str, ...],
    ) -> dict[str, Any]:
        if not isinstance(payload, Mapping):
            raise ZhihuiTmsConfigError(
                "tms_payload_invalid",
                f"{operation} 请求体必须是 JSON object",
            )
        url = f"{self.base_url}/{str(path or '').lstrip('/')}"
        retryable_operation = not login and path == "/findMyStockwarehouseList"
        for _recovery_attempt in range(2):
            headers = {
                "Accept": "application/json, text/plain, */*",
                "Content-Type": "application/json;charset=UTF-8",
                "lang": "zh_CN",
            }
            if login:
                headers["menu-path"] = "#/login"
            elif self._api_token:
                headers["token"] = self._api_token

            recovered = False
            for attempt in range(1, self.retry_policy.max_attempts + 1):
                self._pace_request()
                try:
                    response = self.session.request(
                        "POST",
                        url,
                        headers=headers,
                        json=dict(payload),
                        timeout=self.timeout,
                        allow_redirects=False,
                    )
                except (requests.Timeout, requests.ConnectionError) as exc:
                    if retryable_operation and attempt < self.retry_policy.max_attempts:
                        self._sleep_for_retry(attempt)
                        continue
                    raise ZhihuiTmsTransportError(
                        "tms_transport_error",
                        f"{operation} 网络请求失败: {exc}",
                        secrets=secrets,
                    ) from exc
                except requests.RequestException as exc:
                    raise ZhihuiTmsTransportError(
                        "tms_transport_error",
                        f"{operation} HTTP 客户端失败: {exc}",
                        secrets=secrets,
                    ) from exc

                status_code = int(response.status_code)
                if (
                    retryable_operation
                    and status_code != 429
                    and status_code in self.retry_policy.retryable_status_codes
                    and attempt < self.retry_policy.max_attempts
                ):
                    self._sleep_for_retry(attempt, retry_after=response.headers.get("Retry-After"))
                    continue
                try:
                    return self._decode_response(
                        response,
                        operation=operation,
                        secrets=secrets if login else (self._api_token,),
                        require_http_200=login,
                    )
                except ZhihuiTmsHttpError:
                    if (
                        login
                        or status_code not in {401, 302}
                        or self._authentication_recovery_attempted
                        or self._authentication_recovery is None
                    ):
                        raise
                    self._authentication_recovery_attempted = True
                    self._api_token = ""
                    self._authentication_recovery()
                    if not self._api_token:
                        raise ZhihuiTmsConfigError(
                            "tms_authentication_recovery_failed",
                            f"{operation} 的登录态恢复没有返回 token",
                        )
                    recovered = True
                    break
            if recovered:
                continue

        raise AssertionError("unreachable")

    def _sleep_for_retry(self, attempt: int, *, retry_after: str | None = None) -> None:
        delay = self._parse_retry_after(retry_after)
        if delay is None:
            delay = self.retry_policy.delay(attempt, random_fn=self._random_fn)
        self._sleeper(delay)

    @staticmethod
    def _parse_retry_after(value: str | None) -> float | None:
        if value is None:
            return None
        try:
            delay = float(value)
        except (TypeError, ValueError):
            return None
        return delay if delay >= 0 else None

    @staticmethod
    def _decode_response(
        response: Any,
        *,
        operation: str,
        secrets: tuple[str, ...],
        require_http_200: bool,
    ) -> dict[str, Any]:
        status_code = int(response.status_code)

        if not 200 <= status_code < 300:
            try:
                payload = response.json()
            except Exception:
                payload = None

            if isinstance(payload, Mapping):
                observed_message = str(payload.get("msg") or payload.get("message") or response.text)
            else:
                observed_message = str(getattr(response, "text", "") or "")
            raise ZhihuiTmsHttpError(
                f"tms_http_{status_code}",
                f"{operation} HTTP {status_code}: {observed_message}",
                http_status=status_code,
                payload=payload if payload is not None else observed_message,
                secrets=secrets,
            )

        try:
            payload = response.json()
        except Exception as exc:
            body = str(getattr(response, "text", "") or "")
            raise ZhihuiTmsSchemaError(
                "tms_response_invalid_json",
                f"{operation} 返回了无法解析的 JSON: HTTP {status_code}, body={body}",
                http_status=status_code,
                payload=body,
                secrets=secrets,
            ) from exc

        if not isinstance(payload, Mapping):
            raise ZhihuiTmsSchemaError(
                "tms_response_schema_invalid",
                f"{operation} 返回 JSON 不是 object: HTTP {status_code}",
                http_status=status_code,
                payload=payload,
                secrets=secrets,
            )

        if require_http_200 and status_code != 200:
            observed_message = str(payload.get("msg") or payload.get("message") or response.text)
            raise ZhihuiTmsHttpError(
                f"tms_http_{status_code}",
                f"{operation} HTTP {status_code}: {observed_message}",
                http_status=status_code,
                payload=payload,
                secrets=secrets,
            )

        if payload.get("code") != "200":
            observed_message = str(payload.get("msg") or payload.get("message") or payload.get("code"))
            raise ZhihuiTmsApiError(
                "tms_business_error",
                f"{operation} 业务响应失败: {observed_message}",
                http_status=status_code,
                payload=payload,
                secrets=secrets,
            )
        return dict(payload)


__all__ = [
    "DEFAULT_BASE_URL",
    "DEFAULT_MIN_REQUEST_INTERVAL_SECONDS",
    "DEFAULT_MAX_HTTP_ATTEMPTS",
    "DEFAULT_DOWNLOAD_HOSTS",
    "DEFAULT_MAX_DOWNLOAD_BYTES",
    "DEFAULT_TIMEOUT",
    "RetryPolicy",
    "ZhihuiTmsClient",
]
