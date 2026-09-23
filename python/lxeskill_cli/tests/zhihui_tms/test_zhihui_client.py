from __future__ import annotations

import json
import io
from pathlib import Path
from typing import Any
from zipfile import ZipFile

import pytest
import requests

from services.zhihui_tms.client import RetryPolicy, ZhihuiTmsClient
from services.zhihui_tms.errors import (
    ZhihuiTmsApiError,
    ZhihuiTmsConfigError,
    ZhihuiTmsHttpError,
    ZhihuiTmsSchemaError,
    ZhihuiTmsTransportError,
)


FIXTURES = Path(__file__).parent / "fixtures"


class FakeResponse:
    def __init__(
        self,
        status_code: int,
        payload: Any = None,
        *,
        text: str | None = None,
        headers: dict[str, str] | None = None,
        json_error: Exception | None = None,
        set_cookie: str | None = None,
        content: bytes = b"",
    ) -> None:
        self.status_code = status_code
        self._payload = payload
        self.text = text if text is not None else json.dumps(payload, ensure_ascii=False)
        self.headers = dict(headers or {})
        self.json_error = json_error
        self.set_cookie = set_cookie
        self.content = content

    def json(self) -> Any:
        if self.json_error is not None:
            raise self.json_error
        return self._payload

    def iter_content(self, *, chunk_size: int):
        for start in range(0, len(self.content), chunk_size):
            yield self.content[start : start + chunk_size]


class FakeSession:
    def __init__(self, responses: list[Any]) -> None:
        self.responses = list(responses)
        self.calls: list[dict[str, Any]] = []
        self.cookies = requests.cookies.RequestsCookieJar()

    def request(self, method: str, url: str, **kwargs: Any) -> FakeResponse:
        self.calls.append({"method": method, "url": url, **kwargs})
        response = self.responses.pop(0)
        if isinstance(response, BaseException):
            raise response
        if response.set_cookie:
            self.cookies.set("JSESSIONID", response.set_cookie, domain="tms.mabangerp.com")
        return response


def _fixture(name: str) -> dict[str, Any]:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def _client(session: FakeSession, *, sleeps: list[float] | None = None) -> ZhihuiTmsClient:
    return ZhihuiTmsClient(
        base_url="https://tms.mabangerp.com/tmsapi",
        session=session,
        timeout=(5.0, 30.0),
        retry_policy=RetryPolicy(max_attempts=3, backoff_seconds=1.0, jitter_ratio=0.0),
        sleeper=(sleeps if sleeps is not None else []).append,
        random_fn=lambda: 0.5,
        min_request_interval_seconds=0,
    )


def test_login_sends_documented_body_and_explicit_timeout_without_prelogin_token() -> None:
    session = FakeSession([FakeResponse(200, _fixture("login_success.json"), set_cookie="fixture-session")])
    client = _client(session)

    result = client.login("fixture-user", "fixture-password", local_time="2026-09-17 12:34:56")

    call = session.calls[0]
    assert call["method"] == "POST"
    assert call["url"] == "https://tms.mabangerp.com/tmsapi/login"
    assert call["json"] == {
        "userName": "fixture-user",
        "pwd": "fixture-password",
        "local_time": "2026-09-17 12:34:56",
    }
    assert call["timeout"] == (5.0, 30.0)
    assert call["headers"]["Content-Type"] == "application/json;charset=UTF-8"
    assert call["headers"]["menu-path"] == "#/login"
    assert "token" not in call["headers"]
    assert result.api_token == "fixture-api-token"
    assert client.api_token == "fixture-api-token"
    assert session.cookies.get("JSESSIONID") == "fixture-session"


def test_login_requires_exact_http_200() -> None:
    session = FakeSession([FakeResponse(201, _fixture("login_success.json"))])
    client = _client(session)

    with pytest.raises(ZhihuiTmsHttpError) as captured:
        client.login("fixture-user", "fixture-password", local_time="2026-09-17 12:34:56")

    assert captured.value.http_status == 201
    assert client.api_token == ""


def test_authenticated_post_reuses_session_and_sends_runtime_token() -> None:
    session = FakeSession(
        [
            FakeResponse(200, _fixture("login_success.json"), set_cookie="fixture-session"),
            FakeResponse(200, {"code": "200", "msg": "成功", "datas": []}),
        ]
    )
    client = _client(session)
    client.login("fixture-user", "fixture-password", local_time="2026-09-17 12:34:56")

    result = client.post_json("/findMyStockwarehouseList", {"page": 1}, operation="商品列表")

    assert result["code"] == "200"
    assert session.calls[1]["headers"]["token"] == "fixture-api-token"
    assert session.calls[1]["json"] == {"page": 1}
    assert "menu-path" not in session.calls[1]["headers"]


def test_post_requires_authenticated_session() -> None:
    client = _client(FakeSession([]))

    with pytest.raises(ZhihuiTmsConfigError, match="先完成智汇 TMS 登录"):
        client.post_json("/private", {}, operation="认证请求")


def test_product_endpoint_methods_send_documented_payloads() -> None:
    session = FakeSession(
        [
            FakeResponse(200, {"code": "200", "datas": [], "totalNum": 0}),
            FakeResponse(200, {"code": "200", "pop": "fixture-export-url"}),
        ]
    )
    client = _client(session)
    client._api_token = "fixture-api-token"

    client.find_my_stockwarehouse_list(page=2)
    client.export_stockwarehouse([123, "456"])

    assert session.calls[0]["url"].endswith("/findMyStockwarehouseList")
    assert session.calls[0]["json"] == {
        "page": 2,
        "pageSize": 1000,
        "isConfirm": 1,
        "classId": None,
        "orderBys": "2",
        "status": 1,
        "gridproperty": -1,
        "if_produce": "-1",
        "providerId": "",
        "stockQuantity": -1,
    }
    assert session.calls[1]["url"].endswith("/exportStockwarehouse")
    assert session.calls[1]["json"] == {
        "startNum": None,
        "pageSize": 1000,
        "classId": None,
        "gridproperty": -1,
        "idsList": [123, "456"],
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
    }


def test_retryable_status_uses_bounded_exponential_delay_then_returns_success() -> None:
    sleeps: list[float] = []
    session = FakeSession(
        [
            FakeResponse(503, {"code": "TEMP", "msg": "服务暂时不可用"}),
            FakeResponse(200, {"code": "200", "msg": "成功", "data": {}}),
        ]
    )
    client = _client(session, sleeps=sleeps)
    client._api_token = "fixture-api-token"

    result = client.find_my_stockwarehouse_list(page=1)

    assert result["code"] == "200"
    assert len(session.calls) == 2
    assert sleeps == [1.0]


def test_rate_limit_stops_without_retry() -> None:
    sleeps: list[float] = []
    session = FakeSession(
        [
            FakeResponse(429, {"code": "RATE_LIMIT", "msg": "请求过于频繁"}, headers={"Retry-After": "3"}),
        ]
    )
    client = _client(session, sleeps=sleeps)
    client._api_token = "fixture-api-token"

    with pytest.raises(ZhihuiTmsHttpError) as captured:
        client.find_my_stockwarehouse_list(page=1)

    assert captured.value.http_status == 429
    assert "请求过于频繁" in str(captured.value)
    assert len(session.calls) == 1
    assert sleeps == []


def test_authentication_http_error_stops_without_retry_and_redacts_token() -> None:
    session = FakeSession(
        [
            FakeResponse(
                401,
                {"code": "401", "msg": "token=fixture-api-token 已失效"},
            ),
            FakeResponse(200, {"code": "200"}),
        ]
    )
    client = _client(session)
    client._api_token = "fixture-api-token"

    with pytest.raises(ZhihuiTmsHttpError) as captured:
        client.post_json("/private", {}, operation="认证请求")

    assert len(session.calls) == 1
    assert captured.value.http_status == 401
    assert "fixture-api-token" not in str(captured.value)
    assert "[REDACTED]" in str(captured.value)


def test_http_401_reauthenticates_once_and_replays_the_rejected_request() -> None:
    session = FakeSession(
        [
            FakeResponse(401, {"code": "401", "msg": "token=stale-token 已失效"}),
            FakeResponse(200, _fixture("login_success.json")),
            FakeResponse(200, {"code": "200", "datas": []}),
        ]
    )
    client = _client(session)
    client._api_token = "stale-token"
    recoveries: list[str] = []

    def recover() -> None:
        recoveries.append("called")
        client.login("fixture-user", "fixture-password", local_time="2026-09-17 12:34:56")

    client.set_authentication_recovery(recover)
    result = client.find_my_stockwarehouse_list(page=1)

    assert result["code"] == "200"
    assert recoveries == ["called"]
    assert len(session.calls) == 3
    assert session.calls[0]["headers"]["token"] == "stale-token"
    assert "token" not in session.calls[1]["headers"]
    assert session.calls[2]["headers"]["token"] == "fixture-api-token"


def test_a_second_http_401_stops_after_one_reauthentication() -> None:
    session = FakeSession(
        [
            FakeResponse(401, {"code": "401", "msg": "token=stale-token 已失效"}),
            FakeResponse(200, _fixture("login_success.json")),
            FakeResponse(401, {"code": "401", "msg": "token=fixture-api-token 仍然失效"}),
        ]
    )
    client = _client(session)
    client._api_token = "stale-token"
    recoveries: list[str] = []

    def recover() -> None:
        recoveries.append("called")
        client.login("fixture-user", "fixture-password", local_time="2026-09-17 12:34:56")

    client.set_authentication_recovery(recover)
    with pytest.raises(ZhihuiTmsHttpError) as captured:
        client.find_my_stockwarehouse_list(page=1)

    assert captured.value.http_status == 401
    assert recoveries == ["called"]
    assert len(session.calls) == 3
    assert "fixture-api-token" not in str(captured.value)


def test_http_302_reauthenticates_once_and_replays_the_rejected_request() -> None:
    session = FakeSession(
        [
            FakeResponse(302, text="", headers={"Location": "/login"}, json_error=ValueError("empty")),
            FakeResponse(200, _fixture("login_success.json")),
            FakeResponse(200, {"code": "200", "datas": []}),
        ]
    )
    client = _client(session)
    client._api_token = "stale-token"
    recoveries: list[str] = []

    def recover() -> None:
        recoveries.append("called")
        client.login("fixture-user", "fixture-password", local_time="2026-09-17 12:34:56")

    client.set_authentication_recovery(recover)
    result = client.find_my_stockwarehouse_list(page=1)

    assert result["code"] == "200"
    assert recoveries == ["called"]
    assert len(session.calls) == 3
    assert session.calls[0]["headers"]["token"] == "stale-token"
    assert "token" not in session.calls[1]["headers"]
    assert session.calls[2]["headers"]["token"] == "fixture-api-token"


def test_a_second_http_302_stops_after_one_reauthentication() -> None:
    session = FakeSession(
        [
            FakeResponse(302, text="", headers={"Location": "/login"}, json_error=ValueError("empty")),
            FakeResponse(200, _fixture("login_success.json")),
            FakeResponse(302, text="", headers={"Location": "/login"}, json_error=ValueError("empty")),
        ]
    )
    client = _client(session)
    client._api_token = "stale-token"
    recoveries: list[str] = []

    def recover() -> None:
        recoveries.append("called")
        client.login("fixture-user", "fixture-password", local_time="2026-09-17 12:34:56")

    client.set_authentication_recovery(recover)
    with pytest.raises(ZhihuiTmsHttpError) as captured:
        client.find_my_stockwarehouse_list(page=1)

    assert captured.value.http_status == 302
    assert recoveries == ["called"]
    assert len(session.calls) == 3


@pytest.mark.parametrize("status", [403, 429])
def test_403_and_429_never_invoke_authentication_recovery(status: int) -> None:
    session = FakeSession([FakeResponse(status, {"code": str(status), "msg": "request stopped"})])
    client = _client(session)
    client._api_token = "fixture-api-token"
    recoveries: list[str] = []
    client.set_authentication_recovery(lambda: recoveries.append("called"))

    with pytest.raises(ZhihuiTmsHttpError) as captured:
        client.find_my_stockwarehouse_list(page=1)

    assert captured.value.http_status == status
    assert recoveries == []
    assert len(session.calls) == 1


def test_business_error_preserves_observed_message_and_redacts_payload_secrets() -> None:
    session = FakeSession([FakeResponse(200, _fixture("business_error.json"))])
    client = _client(session)
    client._api_token = "fixture-api-token"

    with pytest.raises(ZhihuiTmsApiError) as captured:
        client.post_json("/private", {}, operation="业务请求")

    assert "账号授权失败" in str(captured.value)
    serialized = str(captured.value) + repr(captured.value.payload)
    assert "fixture-token-echo" not in serialized
    assert "fixture-password" not in serialized


def test_invalid_json_preserves_redacted_observed_body_and_truncates_it() -> None:
    session = FakeSession(
        [
            FakeResponse(
                200,
                text="invalid apiToken=fixture-api-token " + ("x" * 5_000),
                json_error=ValueError("not json"),
            )
        ]
    )
    client = _client(session)
    client._api_token = "fixture-api-token"

    with pytest.raises(ZhihuiTmsSchemaError) as captured:
        client.post_json("/private", {}, operation="结构请求")

    assert "fixture-api-token" not in str(captured.value)
    assert "[REDACTED]" in str(captured.value)
    assert "[truncated " in str(captured.value)


def test_login_timeout_stops_without_retry_and_preserves_redacted_error() -> None:
    sleeps: list[float] = []
    session = FakeSession(
        [
            requests.Timeout("read timed out password=fixture-password"),
            requests.Timeout("read timed out password=fixture-password"),
            requests.Timeout("read timed out password=fixture-password"),
        ]
    )
    client = _client(session, sleeps=sleeps)

    with pytest.raises(ZhihuiTmsTransportError) as captured:
        client.login("fixture-user", "fixture-password", local_time="2026-09-17 12:34:56")

    assert len(session.calls) == 1
    assert sleeps == []
    assert "fixture-password" not in str(captured.value)
    assert "[REDACTED]" in str(captured.value)


def test_export_generation_http_failure_stops_without_retry() -> None:
    session = FakeSession(
        [
            FakeResponse(503, {"code": "TEMP", "msg": "导出状态未知"}),
            FakeResponse(200, {"code": "200", "pop": "duplicate-export"}),
        ]
    )
    client = _client(session)
    client._api_token = "fixture-api-token"

    with pytest.raises(ZhihuiTmsHttpError, match="导出状态未知"):
        client.export_stockwarehouse([123])

    assert len(session.calls) == 1


def test_request_pacing_applies_to_retry_and_next_operation() -> None:
    now = [0.0]
    sleeps: list[float] = []

    def sleep(seconds: float) -> None:
        sleeps.append(seconds)
        now[0] += seconds

    session = FakeSession(
        [
            FakeResponse(503, {"code": "TEMP", "msg": "暂不可用"}),
            FakeResponse(200, {"code": "200", "datas": []}),
            FakeResponse(200, {"code": "200", "datas": []}),
        ]
    )
    client = ZhihuiTmsClient(
        session=session,
        retry_policy=RetryPolicy(max_attempts=3, backoff_seconds=1.0, jitter_ratio=0.0),
        sleeper=sleep,
        clock=lambda: now[0],
        min_request_interval_seconds=2.0,
    )
    client._api_token = "fixture-api-token"

    client.find_my_stockwarehouse_list(page=1)
    client.find_my_stockwarehouse_list(page=2)

    assert len(session.calls) == 3
    assert sleeps == [1.0, 1.0, 2.0]


def test_download_429_stops_without_retry() -> None:
    session = FakeSession([FakeResponse(429, text="slow down", headers={"Retry-After": "10"})])
    with pytest.raises(ZhihuiTmsHttpError) as captured:
        _client(session).download_bytes("https://tms-cos.mabangerp.com/export/fixture.xlsx")
    assert captured.value.http_status == 429
    assert len(session.calls) == 1


def test_http_attempt_budget_counts_retries_before_sending_another_request() -> None:
    session = FakeSession([
        FakeResponse(503, {"code": "TEMP", "msg": "暂不可用"}),
        FakeResponse(200, {"code": "200", "datas": []}),
        FakeResponse(200, {"code": "200", "datas": []}),
    ])
    client = ZhihuiTmsClient(
        session=session,
        retry_policy=RetryPolicy(max_attempts=3, backoff_seconds=0, jitter_ratio=0),
        sleeper=lambda _seconds: None,
        min_request_interval_seconds=0,
        max_http_attempts=2,
    )
    client._api_token = "fixture-api-token"

    client.find_my_stockwarehouse_list(page=1)
    with pytest.raises(ZhihuiTmsConfigError, match="HTTP 请求尝试次数"):
        client.find_my_stockwarehouse_list(page=2)

    assert client.request_attempt_count == 2
    assert len(session.calls) == 2


def _minimal_xlsx_bytes() -> bytes:
    buffer = io.BytesIO()
    with ZipFile(buffer, "w") as archive:
        archive.writestr("[Content_Types].xml", "<Types />")
    return buffer.getvalue()


def test_download_validates_https_trusted_host_and_does_not_send_api_token() -> None:
    content = _minimal_xlsx_bytes()
    session = FakeSession(
        [
            FakeResponse(
                200,
                text="",
                content=content,
                headers={
                    "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    "Content-Length": str(len(content)),
                },
            )
        ]
    )
    client = _client(session)
    client._api_token = "fixture-api-token"

    downloaded, content_type = client.download_bytes("https://tms-cos.mabangerp.com/export/fixture.xlsx")

    assert downloaded == content
    assert content_type == "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    assert session.calls[0]["method"] == "GET"
    assert "token" not in session.calls[0]["headers"]
    assert session.calls[0]["allow_redirects"] is False

    with pytest.raises(ZhihuiTmsConfigError, match="HTTPS"):
        client.download_bytes("http://tms-cos.mabangerp.com/export/fixture.xlsx")
    with pytest.raises(ZhihuiTmsConfigError, match="可信"):
        client.download_bytes("https://evil.example.test/export/fixture.xlsx")


def test_download_rejects_redirect_wrong_mime_and_oversized_response() -> None:
    content = _minimal_xlsx_bytes()
    redirect_session = FakeSession([FakeResponse(302, text="redirect", headers={"Location": "https://evil.example.test"})])
    with pytest.raises(ZhihuiTmsHttpError, match="302"):
        _client(redirect_session).download_bytes("https://tms-cos.mabangerp.com/export/fixture.xlsx")

    wrong_mime = FakeSession(
        [
            FakeResponse(
                200,
                text="",
                content=content,
                headers={"Content-Type": "text/plain"},
            )
        ]
    )
    with pytest.raises(ZhihuiTmsSchemaError, match="MIME"):
        _client(wrong_mime).download_bytes("https://tms-cos.mabangerp.com/export/fixture.xlsx")

    oversized = FakeSession(
        [
            FakeResponse(
                200,
                text="",
                content=content,
                headers={
                    "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    "Content-Length": str(len(content) + 1),
                },
            )
        ]
    )
    with pytest.raises(ZhihuiTmsSchemaError, match="大小"):
        _client(oversized).download_bytes(
            "https://tms-cos.mabangerp.com/export/fixture.xlsx",
            max_bytes=len(content),
        )


def test_download_retries_temporary_status_and_validates_xls_signature() -> None:
    sleeps: list[float] = []
    xls_content = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + (b"x" * 32)
    session = FakeSession(
        [
            FakeResponse(503, {"code": "TEMP", "msg": "文件暂时不可用"}),
            FakeResponse(
                200,
                text="",
                content=xls_content,
                headers={"Content-Type": "application/vnd.ms-excel"},
            ),
        ]
    )
    client = _client(session, sleeps=sleeps)

    downloaded, content_type = client.download_bytes("https://tms-cos.mabangerp.com/export/fixture.xls")

    assert downloaded == xls_content
    assert content_type == "application/vnd.ms-excel"
    assert sleeps == [1.0]


def test_download_retries_transient_stream_read_failure() -> None:
    class StreamingFailure(FakeResponse):
        def iter_content(self, *, chunk_size: int):
            raise requests.ConnectionError("fixture stream reset")

    sleeps: list[float] = []
    content = _minimal_xlsx_bytes()
    session = FakeSession(
        [
            StreamingFailure(
                200,
                text="",
                content=b"",
                headers={"Content-Type": "application/octet-stream"},
            ),
            FakeResponse(
                200,
                text="",
                content=content,
                headers={"Content-Type": "application/octet-stream"},
            ),
        ]
    )

    downloaded, _ = _client(session, sleeps=sleeps).download_bytes(
        "https://tms-cos.mabangerp.com/export/fixture.xlsx"
    )

    assert downloaded == content
    assert sleeps == [1.0]
