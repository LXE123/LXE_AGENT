from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any, Callable, Literal, Mapping

import requests

from services.yacang.download import WEB_ORIGIN, download_xlsx
from services.yacang.errors import YacangError, safe_remote_detail
from services.yacang.production import YacangProductionGuard
from shared.infra.net.requests_client import external_requests_session


API_ORIGIN = "https://api-oms.seaya.cn"
JSON_REQUEST_TIMEOUT = (10.0, 60.0)
QUEUE_NETWORK_RETRY_BACKOFF_SECONDS = 3.0
GET_5XX_RETRY_BACKOFF_SECONDS = 5.0
RequestPurpose = Literal["auth", "queue", "submit"]


class YacangClient:
    def __init__(
        self,
        session: requests.Session | Any = external_requests_session,
        *,
        production_guard: YacangProductionGuard | Any | None = None,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self._session = session
        self._token = ""
        self._production_guard = production_guard or YacangProductionGuard()
        self._sleep = sleep

    @property
    def _json_headers(self) -> dict[str, str]:
        headers = {
            "Accept": "application/json, text/plain, */*",
            "Origin": WEB_ORIGIN,
            "Referer": f"{WEB_ORIGIN}/",
        }
        if self._token:
            headers["token"] = self._token
        return headers

    @property
    def is_authenticated(self) -> bool:
        return bool(self._token)

    def _json_request(
        self,
        method: str,
        path: str,
        *,
        stage: str,
        purpose: RequestPurpose,
        params: Mapping[str, Any] | None = None,
        json_body: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        url = f"{API_ORIGIN}{path}"
        attempt = 0
        while True:
            try:
                with self._production_guard.request_slot():
                    response = self._session.request(
                        method,
                        url,
                        headers=self._json_headers,
                        params=dict(params or {}),
                        json=dict(json_body) if json_body is not None else None,
                        timeout=JSON_REQUEST_TIMEOUT,
                    )
                    if int(response.status_code) == 429:
                        self._production_guard.activate_rate_limit()
            except requests.RequestException as exc:
                if purpose == "queue" and attempt == 0:
                    attempt += 1
                    self._sleep(QUEUE_NETWORK_RETRY_BACKOFF_SECONDS)
                    continue
                code = "EXPORT_SUBMIT_UNKNOWN" if purpose == "submit" else "YACANG_NETWORK_ERROR"
                raise YacangError(
                    stage,
                    type(exc).__name__,
                    code=code,
                    error_type=type(exc).__name__,
                    scope="global" if purpose in {"auth", "queue", "submit"} else "local",
                ) from None

            status = int(response.status_code)
            try:
                status_detail = safe_remote_detail(response.json())
            except (requests.JSONDecodeError, json.JSONDecodeError, ValueError):
                status_detail = safe_remote_detail(response.text)
            if status == 429:
                raise YacangError(
                    stage,
                    f"HTTP 429 rate_limited，已进入 15 分钟 cooldown；响应: {status_detail}",
                    code="YACANG_RATE_LIMITED",
                    http_status=status,
                    scope="global",
                )
            if status == 401:
                raise YacangError(
                    stage,
                    f"HTTP 401 认证失效；响应: {status_detail}",
                    code="YACANG_AUTH_EXPIRED",
                    http_status=status,
                    scope="global",
                )
            if status == 403:
                raise YacangError(
                    stage,
                    f"HTTP 403 已拒绝继续请求；响应: {status_detail}",
                    code="YACANG_FORBIDDEN",
                    http_status=status,
                    scope="global",
                )
            if 500 <= status <= 599 and purpose == "queue" and attempt == 0:
                attempt += 1
                self._sleep(GET_5XX_RETRY_BACKOFF_SECONDS)
                continue
            break

        try:
            payload = response.json()
        except (requests.JSONDecodeError, json.JSONDecodeError, ValueError) as exc:
            detail = safe_remote_detail(response.text)
            code = "EXPORT_SUBMIT_UNKNOWN" if purpose == "submit" else (
                "EXPORT_STATUS_UNKNOWN" if purpose == "queue" else "YACANG_RESPONSE_INVALID"
            )
            raise YacangError(
                stage,
                f"HTTP {response.status_code}, 非 JSON 响应: {detail}",
                code=code,
                http_status=int(response.status_code),
                scope="global",
            ) from None
        if not isinstance(payload, dict):
            raise YacangError(
                stage,
                f"HTTP {response.status_code}, 响应结构无效: {safe_remote_detail(payload)}",
                code="EXPORT_STATUS_UNKNOWN" if purpose == "queue" else "YACANG_RESPONSE_INVALID",
                http_status=int(response.status_code),
                scope="global",
            )
        if response.status_code != 200 or payload.get("status") != 1:
            code = "EXPORT_SUBMIT_UNKNOWN" if purpose == "submit" and response.status_code >= 500 else (
                "EXPORT_SUBMIT_FAILED" if purpose == "submit" else (
                    "EXPORT_STATUS_UNKNOWN" if purpose == "queue" else "YACANG_REMOTE_ERROR"
                )
            )
            raise YacangError(
                stage,
                f"HTTP {response.status_code}, 响应: {safe_remote_detail(payload)}",
                code=code,
                http_status=int(response.status_code),
                scope="global" if purpose in {"auth", "queue"} or code == "EXPORT_SUBMIT_UNKNOWN" else "local",
            )
        return payload

    def login(self, mobile: str, password: str) -> None:
        verify = self._json_request(
            "GET", "/sys/customer/verify", stage="获取登录验证码", purpose="auth"
        )
        verify_data = verify.get("data")
        if not isinstance(verify_data, dict):
            raise YacangError(
                "获取登录验证码",
                f"缺少 data: {safe_remote_detail(verify)}",
                code="YACANG_CAPTCHA_INVALID",
                scope="global",
            )
        key = str(verify_data.get("key") or "").strip()
        code = str(verify_data.get("code") or "").strip()
        if not key or not code:
            raise YacangError(
                "获取登录验证码",
                f"缺少 key/code: {safe_remote_detail(verify)}",
                code="YACANG_CAPTCHA_INVALID",
                scope="global",
            )

        login = self._json_request(
            "POST",
            "/sys/customer/loginV3",
            stage="登录",
            purpose="auth",
            json_body={
                "mobile": mobile,
                "password": password,
                "verify_code": code,
                "lang": "zh-cn",
                "key": key,
            },
        )
        login_data = login.get("data")
        token = str(login_data.get("token") or "").strip() if isinstance(login_data, dict) else ""
        if not token:
            raise YacangError(
                "登录",
                f"成功响应缺少 token: {safe_remote_detail(login)}",
                code="YACANG_TOKEN_INVALID",
                scope="global",
            )
        self._token = token

    def list_downloads(self, *, limit: int = 50) -> list[dict[str, Any]]:
        payload = self._json_request(
            "GET",
            "/sys/customer/downPath/list",
            stage="读取导出队列",
            purpose="queue",
            params={"page": 1, "limit": limit},
        )
        data = payload.get("data")
        rows = data.get("list") if isinstance(data, dict) else None
        if not isinstance(rows, list):
            raise YacangError(
                "读取导出队列",
                f"缺少 data.list: {safe_remote_detail(payload)}",
                code="EXPORT_STATUS_UNKNOWN",
                scope="global",
            )
        if any(not isinstance(row, dict) or not str(row.get("id") or "").strip() for row in rows):
            raise YacangError(
                "读取导出队列",
                "data.list 包含非对象或缺少 id 的任务行",
                code="EXPORT_STATUS_UNKNOWN",
                scope="global",
            )
        return [dict(row) for row in rows]

    def create_inventory_sales_export(
        self,
        *,
        warehouse_id: int,
        start_date: str,
        end_date: str,
    ) -> str:
        payload = self._json_request(
            "GET",
            "/sys/customer/mrpPrepare/export",
            stage="提交库存动销导出",
            purpose="submit",
            params={
                "page": 1,
                "limit": 10,
                "create_time": f"{start_date} - {end_date}",
                "sku_condition": 1,
                "warehouse_id": warehouse_id,
            },
        )
        return str(payload.get("request_id") or "")

    def create_inventory_list_export(self, *, warehouse_id: int) -> str:
        payload = self._json_request(
            "GET",
            "/sys/customer/stockWarehouse/export",
            stage="提交库存列表导出",
            purpose="submit",
            params={
                "page": 1,
                "limit": 10,
                "goods_sku_condition": 2,
                "warehouse_id": warehouse_id,
            },
        )
        return str(payload.get("request_id") or "")

    def create_inbound_listing_time_export(self) -> str:
        payload = self._json_request(
            "GET",
            "/sys/customer/sku/export",
            stage="提交仓库产品资料导出",
            purpose="submit",
            params={
                "page": 1,
                "limit": 10,
                "status": 1,
                "goods_sku_condition": 2,
            },
        )
        return str(payload.get("request_id") or "")

    def download_xlsx(self, url: str, destination: Path) -> None:
        download_xlsx(
            self._session,
            url,
            destination,
            production_guard=self._production_guard,
            sleep=self._sleep,
        )


__all__ = ["JSON_REQUEST_TIMEOUT", "YacangClient"]
