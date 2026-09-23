"""Small, read-only transport for the Zhihui TMS API."""
from __future__ import annotations

import asyncio
import json
import os
import re
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

import aiohttp

from shared.infra.net import external_http_session

BASE_URL = "https://tms.mabangerp.com/tmsapi"
MAX_ATTEMPTS = 3
_SECRET = re.compile(r"(?i)(password|passwd|token|cookie|secret|authorization)\\s*[:=]\\s*[^,; }]+")


def diagnostic(value: Any) -> str:
    raw = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, default=str)
    raw = _SECRET.sub(lambda m: f"{m.group(1)}=[REDACTED]", raw)
    return raw[:3800] + (f"... [truncated {len(raw) - 3800} chars]" if len(raw) > 3800 else "")


class ZhihuiTmsError(RuntimeError):
    pass


class ZhihuiTmsAuthError(ZhihuiTmsError):
    pass


class ZhihuiTmsRequestError(ZhihuiTmsError):
    pass


@dataclass(frozen=True)
class ZhihuiTmsSession:
    api_token: str = field(repr=False)
    cookie_header: str = field(default="", repr=False)


Sleep = Callable[[float], Awaitable[None]]


class ZhihuiTmsClient:
    def __init__(self, *, username: str = "", password: str = "", base_url: str = BASE_URL,
                 session: Any = external_http_session, sleep: Sleep = asyncio.sleep) -> None:
        self.username = username.strip() or os.getenv("LXE_ZHIHUI_TMS_USERNAME", "").strip()
        self.password = password or os.getenv("LXE_ZHIHUI_TMS_PASSWORD", "")
        self.base_url = base_url.rstrip("/")
        self.http = session
        self.sleep = sleep
        self.session: ZhihuiTmsSession | None = None

    async def login(self, *, local_time: str) -> ZhihuiTmsSession:
        if not self.username or not self.password:
            raise ZhihuiTmsAuthError("智汇 TMS 用户名或密码未配置")
        try:
            payload, headers = await self._request(
                "/login", {"userName": self.username, "pwd": self.password, "local_time": local_time}, auth=False
            )
        except ZhihuiTmsRequestError as exc:
            raise ZhihuiTmsAuthError(str(exc)) from exc
        data = payload.get("data")
        token = data.get("apiToken", "") if isinstance(data, dict) else ""
        if payload.get("code") != "200" or not str(token).strip():
            raise ZhihuiTmsAuthError(f"智汇 TMS 登录失败: {diagnostic(payload)}")
        self.session = ZhihuiTmsSession(api_token=str(token).strip(), cookie_header=headers.get("Set-Cookie", ""))
        return self.session

    async def _request(self, endpoint: str, body: dict[str, Any], *, auth: bool = True) -> tuple[dict[str, Any], dict[str, str]]:
        headers = {"Accept": "application/json, text/plain, */*", "Content-Type": "application/json;charset=UTF-8", "lang": "zh_CN"}
        if auth:
            if self.session is None:
                raise ZhihuiTmsAuthError("智汇 TMS Session 不存在")
            headers["token"] = self.session.api_token
            if self.session.cookie_header:
                headers["Cookie"] = self.session.cookie_header
        for attempt in range(MAX_ATTEMPTS):
            try:
                async with self.http.post(self.base_url + endpoint, json=body, headers=headers, allow_redirects=False,
                                          timeout=aiohttp.ClientTimeout(total=30)) as response:
                    raw = await response.text()
                    status = response.status
                    response_headers = dict(response.headers)
            except (aiohttp.ClientError, asyncio.TimeoutError) as exc:
                if attempt + 1 < MAX_ATTEMPTS:
                    await self.sleep(2 ** attempt)
                    continue
                raise ZhihuiTmsRequestError(f"智汇 TMS 请求失败: {type(exc).__name__}: {diagnostic(exc)}") from exc
            try:
                parsed = json.loads(raw)
            except ValueError:
                parsed = raw
            if status in (408, 429, 500, 502, 503, 504) and attempt + 1 < MAX_ATTEMPTS:
                await self.sleep(2 ** attempt)
                continue
            if not 200 <= status < 300:
                raise ZhihuiTmsRequestError(f"智汇 TMS HTTP {status}: {diagnostic(parsed)}")
            if not isinstance(parsed, dict):
                raise ZhihuiTmsRequestError(f"智汇 TMS 响应不是 JSON 对象: {diagnostic(parsed)}")
            if str(parsed.get("code")) != "200":
                raise ZhihuiTmsRequestError(f"智汇 TMS 业务失败: {diagnostic(parsed)}")
            return parsed, response_headers
        raise AssertionError("unreachable")
