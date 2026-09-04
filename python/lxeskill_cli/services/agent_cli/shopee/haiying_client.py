"""海鹰数据平台客户端：AES 登录、关键词搜索量分页抓取。

移植自原 shopee-keyword-search 脚本的 service.py，行为保持一致；
差异：一次性 CLI 进程没有跨进程 Token 缓存，每次命令执行都会重新登录。
"""
from __future__ import annotations

import base64
import math
import time
from typing import Any, Callable

import requests
from cryptography.hazmat.primitives import padding
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes


BASE_URL = "https://www.haiyingshuju.com"
LOGIN_URL = f"{BASE_URL}/auth/login"
KEYWORD_URL = f"{BASE_URL}/shopee/keyword/keywordInfo"
LOGIN_AES_KEY = b"8NONwyJtHesysWpM"

PAGE_SIZE = 500
SEARCH_TYPE = 2
ORDER_COLUMN = "search_volume"
SORT_ORDER = "DESC"
TIMEOUT_SECONDS = 45
MAX_RETRIES = 4
REQUEST_INTERVAL_SECONDS = 0.10
SERVER_PAGE_LIMIT = 500

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/150.0.0.0 Safari/537.36"
)
REFERER = "https://www.haiyingshuju.com/haiyingshopee/index.html"


class AuthenticationError(RuntimeError):
    pass


class TokenRejectedError(AuthenticationError):
    pass


class HaiyingApiError(RuntimeError):
    pass


def encrypt_login_value(value: str) -> str:
    padder = padding.PKCS7(128).padder()
    padded = padder.update(value.encode("utf-8")) + padder.finalize()
    encryptor = Cipher(algorithms.AES(LOGIN_AES_KEY), modes.ECB()).encryptor()
    encrypted = encryptor.update(padded) + encryptor.finalize()
    return base64.b64encode(encrypted).decode("ascii")


def build_payload(country_code: int, keyword: str, page_index: int) -> dict[str, Any]:
    return {
        "country": country_code,
        "index": page_index,
        "pageSize": PAGE_SIZE,
        "title": keyword,
        "searchType": SEARCH_TYPE,
        "sort": SORT_ORDER,
        "orderColumn": ORDER_COLUMN,
        "search_volume_start": "",
        "search_volume_end": "",
        "recommend_price_start": "",
        "recommend_price_end": "",
        "total_count_start": "",
        "total_count_end": "",
        "search_volume_index_Start": "",
        "search_volume_index_End": "",
    }


def _body_code(body: dict[str, Any]) -> str:
    return str(body.get("code") if body.get("code") is not None else "").strip()


def _body_message(body: dict[str, Any]) -> str:
    return str(body.get("msg") or body.get("message") or "").strip()


def _is_auth_rejection(response: requests.Response, body: dict[str, Any]) -> bool:
    if response.status_code in (401, 403):
        return True
    if _body_code(body) in {"401", "403"}:
        return True
    message = _body_message(body).casefold()
    auth_markers = [
        "token",
        "登录",
        "登陆",
        "未认证",
        "认证失败",
        "无权限",
        "权限不足",
        "过期",
        "失效",
    ]
    return _body_code(body) != "1" and any(marker in message for marker in auth_markers)


class HaiyingClient:
    def __init__(self, username: str, password: str) -> None:
        if PAGE_SIZE <= 0 or PAGE_SIZE > SERVER_PAGE_LIMIT:
            raise ValueError(f"PAGE_SIZE 必须在 1 到 {SERVER_PAGE_LIMIT} 之间")
        if SEARCH_TYPE != 2:
            raise ValueError("SEARCH_TYPE 必须固定为 2（模糊搜索）")
        if not username:
            raise AuthenticationError("海鹰账号为空")
        if not password:
            raise AuthenticationError("海鹰密码为空")
        self._username = username
        self._password = password
        self.session = requests.Session()
        self.session.headers.update(
            {
                "accept": "application/json, text/plain, */*",
                "user-agent": USER_AGENT,
                "referer": REFERER,
            }
        )

    def close(self) -> None:
        self.session.close()

    def _set_token(self, token: str) -> None:
        self.session.headers["token"] = str(token).strip()

    def _clear_rejected_token(self) -> None:
        self.session.headers.pop("token", None)

    def login(self) -> None:
        last_error: Exception | None = None
        for attempt in range(1, MAX_RETRIES + 1):
            try:
                response = self.session.post(
                    LOGIN_URL,
                    data={
                        "username": encrypt_login_value(self._username),
                        "password": encrypt_login_value(self._password),
                    },
                    headers={
                        "content-type": "application/x-www-form-urlencoded",
                        "token": "",
                    },
                    timeout=TIMEOUT_SECONDS,
                )
                if response.status_code == 429 or response.status_code >= 500:
                    raise requests.HTTPError(
                        f"HTTP {response.status_code}",
                        response=response,
                    )
                response.raise_for_status()
                token = str(response.headers.get("token") or "").strip()
                if not token:
                    message = ""
                    try:
                        body = response.json()
                        if isinstance(body, dict):
                            message = _body_message(body) or str(body)
                    except (ValueError, AttributeError):
                        pass
                    raise AuthenticationError(
                        f"海鹰登录失败，响应中没有 Token。{message}"
                    )
                self._set_token(token)
                return
            except AuthenticationError:
                raise
            except (
                requests.ConnectionError,
                requests.Timeout,
                requests.HTTPError,
            ) as exc:
                last_error = exc
                if attempt < MAX_RETRIES:
                    time.sleep(min(8.0, 0.8 * (2 ** (attempt - 1))))
        raise AuthenticationError(f"海鹰登录重试 {MAX_RETRIES} 次仍失败：{last_error}")

    def _request_page_without_relogin(self, payload: dict[str, Any]) -> dict[str, Any]:
        last_error: Exception | None = None
        for attempt in range(1, MAX_RETRIES + 1):
            try:
                response = self.session.post(
                    KEYWORD_URL,
                    json=payload,
                    headers={"content-type": "application/json;charset=UTF-8"},
                    timeout=TIMEOUT_SECONDS,
                )
                body: dict[str, Any] = {}
                try:
                    parsed = response.json()
                    if isinstance(parsed, dict):
                        body = parsed
                except (ValueError, requests.JSONDecodeError):
                    body = {}
                if _is_auth_rejection(response, body):
                    raise TokenRejectedError(
                        _body_message(body)
                        or f"HTTP {response.status_code}，海鹰 Token 已失效"
                    )
                if response.status_code == 429 or response.status_code >= 500:
                    raise requests.HTTPError(
                        f"HTTP {response.status_code}",
                        response=response,
                    )
                response.raise_for_status()
                if not body:
                    raise HaiyingApiError("海鹰接口未返回有效 JSON")
                if _body_code(body) != "1":
                    raise HaiyingApiError(
                        f"海鹰接口 code={_body_code(body) or '未知'}："
                        f"{_body_message(body) or body}"
                    )
                return body
            except TokenRejectedError:
                raise
            except (
                requests.ConnectionError,
                requests.Timeout,
                requests.HTTPError,
                requests.JSONDecodeError,
                HaiyingApiError,
            ) as exc:
                last_error = exc
                if attempt < MAX_RETRIES:
                    time.sleep(min(8.0, 0.8 * (2 ** (attempt - 1))))
        raise HaiyingApiError(f"海鹰请求重试 {MAX_RETRIES} 次仍失败：{last_error}")

    def request_page(self, payload: dict[str, Any]) -> dict[str, Any]:
        try:
            return self._request_page_without_relogin(payload)
        except TokenRejectedError:
            self._clear_rejected_token()
            self.login()
            try:
                return self._request_page_without_relogin(payload)
            except TokenRejectedError as exc:
                raise AuthenticationError(
                    f"重新登录后海鹰接口仍拒绝 Token：{exc}"
                ) from exc


def fetch_all_pages(
    client: HaiyingClient,
    country: dict[str, Any],
    keyword: str,
    *,
    on_progress: Callable[[dict[str, Any]], None] | None = None,
) -> tuple[dict[str, int | float | None], dict[str, int]]:
    """翻完一个 (国家, 关键词) 查询的全部分页，返回 {搜索词: 搜索量} 与统计。"""
    output: dict[str, int | float | None] = {}
    page_index = 1
    keyword_total = 0
    raw_rows = 0

    while True:
        body = client.request_page(build_payload(int(country["code"]), keyword, page_index))
        raw_data = body.get("data")
        items = raw_data if isinstance(raw_data, list) else []
        page_total = int(body.get("keywordTotal") or 0)
        keyword_total = max(keyword_total, page_total)
        total_pages = math.ceil(keyword_total / PAGE_SIZE) if keyword_total else 1

        for item in items:
            if not isinstance(item, dict) or item.get("keyword") is None:
                continue
            returned_keyword = str(item["keyword"])
            if returned_keyword not in output:
                output[returned_keyword] = item.get("search_volume")

        raw_rows += len(items)
        if on_progress is not None and (
            page_index == 1 or page_index % 10 == 0 or page_index >= total_pages
        ):
            on_progress(
                {
                    "stage": "fetch_pages",
                    "country": str(country["name"]),
                    "keyword": keyword,
                    "page": page_index,
                    "total_pages": total_pages,
                    "raw_rows": raw_rows,
                    "unique_keywords": len(output),
                }
            )

        if (
            keyword_total == 0
            or raw_rows >= keyword_total
            or page_index >= total_pages
        ):
            break
        if not items:
            break
        page_index += 1
        time.sleep(REQUEST_INTERVAL_SECONDS)

    return output, {
        "keyword_total": keyword_total,
        "raw_rows": raw_rows,
        "unique_keywords": len(output),
        "pages": page_index,
    }
