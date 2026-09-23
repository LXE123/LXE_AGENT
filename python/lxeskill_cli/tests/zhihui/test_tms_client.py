from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from services.zhihui.tms_client import ZhihuiTmsAuthError, ZhihuiTmsClient


class Response:
    def __init__(self, status: int, payload: object, headers: dict[str, str] | None = None):
        self.status, self.payload, self.headers = status, payload, headers or {}
    async def __aenter__(self): return self
    async def __aexit__(self, *_): return None
    async def text(self):
        import json
        return json.dumps(self.payload)


class Http:
    def __init__(self, responses): self.responses, self.calls = list(responses), []
    def post(self, *args, **kwargs):
        self.calls.append((args, kwargs)); return self.responses.pop(0)


def test_login_validates_token_and_keeps_cookie_out_of_repr():
    http = Http([Response(200, {"code": "200", "data": {"apiToken": "secret-token"}}, {"Set-Cookie": "JSESSIONID=secret"})])
    client = ZhihuiTmsClient(username="u", password="p", session=http)
    result = asyncio.run(client.login(local_time="2026-09-17 10:00:00"))
    assert result.api_token == "secret-token"
    assert "secret-token" not in repr(result)
    assert http.calls[0][1]["json"]["pwd"] == "p"


def test_login_requires_non_empty_token():
    http = Http([Response(200, {"code": "200", "data": {"apiToken": ""}})])
    with pytest.raises(ZhihuiTmsAuthError, match="登录失败"):
        asyncio.run(ZhihuiTmsClient(username="u", password="p", session=http).login(local_time="now"))


def test_transient_http_failure_retries_with_backoff():
    http = Http([Response(503, {"code": "503"}), Response(200, {"code": "200", "data": {"apiToken": "t"}})])
    sleeps: list[float] = []
    async def sleep(seconds): sleeps.append(seconds)
    client = ZhihuiTmsClient(username="u", password="p", session=http, sleep=sleep)
    asyncio.run(client.login(local_time="now"))
    assert sleeps == [1]

