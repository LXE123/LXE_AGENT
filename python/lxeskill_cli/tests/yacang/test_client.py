from __future__ import annotations

from contextlib import contextmanager
from typing import Any, Iterator

import pytest
import requests

from services.yacang.client import JSON_REQUEST_TIMEOUT, YacangClient
from services.yacang.errors import YacangError, safe_remote_detail
from services.yacang.production import MemoryCooldownStore, MemoryRequestGate, YacangProductionGuard


def _guard() -> YacangProductionGuard:
    return YacangProductionGuard(
        enabled=True,
        cooldown=MemoryCooldownStore(),
        request_gate=MemoryRequestGate(),
    )


class FakeResponse:
    def __init__(self, payload: Any, *, status_code: int = 200) -> None:
        self._payload = payload
        self.status_code = status_code
        self.text = str(payload)
        self.headers: dict[str, str] = {}

    def json(self) -> Any:
        return self._payload


class FakeSession:
    def __init__(self, responses: list[FakeResponse | Exception]) -> None:
        self.responses = list(responses)
        self.calls: list[tuple[str, str, dict[str, Any]]] = []

    def request(self, method: str, url: str, **kwargs: Any) -> FakeResponse:
        self.calls.append((method, url, kwargs))
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response


class CooldownObservingGate:
    def __init__(self, cooldown: MemoryCooldownStore) -> None:
        self.cooldown = cooldown
        self.remaining_when_released = 0

    @contextmanager
    def slot(self) -> Iterator[None]:
        try:
            yield
        finally:
            self.remaining_when_released = self.cooldown.remaining_seconds()


def test_login_uses_server_returned_code_and_keeps_token_in_client_only() -> None:
    session = FakeSession([
        FakeResponse({
            "status": 1,
            "message": "success",
            "data": {
                "key": "fake-key",
                "captcha": "data:image/jpeg;base64,not-used",
                "code": "2468",
            },
        }),
        FakeResponse({
            "status": 1,
            "message": "success",
            "data": {"token": "fake-token", "exp": 604800},
        }),
        FakeResponse({"status": 1, "message": "success", "data": {"list": []}}),
    ])
    client = YacangClient(session, production_guard=_guard())  # type: ignore[arg-type]

    assert client.login("mobile", "password") is None
    method, url, kwargs = session.calls[1]
    assert method == "POST"
    assert url.endswith("/sys/customer/loginV3")
    assert kwargs["json"] == {
        "mobile": "mobile",
        "password": "password",
        "verify_code": "2468",
        "lang": "zh-cn",
        "key": "fake-key",
    }
    assert all(call[2]["timeout"] == JSON_REQUEST_TIMEOUT for call in session.calls[:2])

    assert client.list_downloads() == []
    assert session.calls[2][2]["headers"]["token"] == "fake-token"


def test_inbound_listing_time_export_uses_confirmed_product_parameters() -> None:
    session = FakeSession([
        FakeResponse({"status": 1, "message": "下载中，请稍后下载列表查看", "request_id": "fixture"}),
    ])
    client = YacangClient(session, production_guard=_guard())  # type: ignore[arg-type]

    assert client.create_inbound_listing_time_export() == "fixture"
    method, url, kwargs = session.calls[0]
    assert method == "GET"
    assert url.endswith("/sys/customer/sku/export")
    assert kwargs["params"] == {
        "page": 1,
        "limit": 10,
        "status": 1,
        "goods_sku_condition": 2,
    }


def test_business_error_preserves_remote_message_but_redacts_token() -> None:
    session = FakeSession([
        FakeResponse({"status": 0, "message": "token expired", "token": "private-value"}, status_code=401),
    ])
    client = YacangClient(session, production_guard=_guard())  # type: ignore[arg-type]

    with pytest.raises(YacangError) as caught:
        client.list_downloads()

    message = str(caught.value)
    assert "HTTP 401" in message
    assert "token expired" in message
    assert "private-value" not in message


def test_arbitrary_error_text_redacts_tokens_and_temporary_urls() -> None:
    detail = safe_remote_detail(
        "request failed token=fake-secret https://oss-accelerate.seaya.cn/example/private.xlsx"
    )

    assert "fake-secret" not in detail
    assert "private.xlsx" not in detail


def test_inventory_list_export_uses_confirmed_endpoint_and_fixed_filter() -> None:
    session = FakeSession([
        FakeResponse({"status": 1, "message": "下载中，请稍后下载列表查看", "request_id": "fixture"}),
    ])
    client = YacangClient(session, production_guard=_guard())  # type: ignore[arg-type]

    assert client.create_inventory_list_export(warehouse_id=26) == "fixture"
    method, url, kwargs = session.calls[0]
    assert method == "GET"
    assert url.endswith("/sys/customer/stockWarehouse/export")
    assert kwargs["params"] == {
        "page": 1,
        "limit": 10,
        "goods_sku_condition": 2,
        "warehouse_id": 26,
    }
    assert kwargs["timeout"] == JSON_REQUEST_TIMEOUT


def test_side_effecting_get_submit_timeout_is_never_retried() -> None:
    session = FakeSession([requests.Timeout("ambiguous submit")])
    sleeps: list[float] = []
    client = YacangClient(
        session,
        production_guard=_guard(),
        sleep=sleeps.append,
    )  # type: ignore[arg-type]

    with pytest.raises(YacangError) as caught:
        client.create_inventory_list_export(warehouse_id=26)

    assert caught.value.code == "EXPORT_SUBMIT_UNKNOWN"
    assert caught.value.scope == "global"
    assert len(session.calls) == 1
    assert session.calls[0][0] == "GET"
    assert sleeps == []


def test_queue_network_error_retries_once_after_three_seconds() -> None:
    session = FakeSession([
        requests.Timeout("temporary"),
        FakeResponse({"status": 1, "message": "success", "data": {"list": []}}),
    ])
    sleeps: list[float] = []
    client = YacangClient(session, production_guard=_guard(), sleep=sleeps.append)  # type: ignore[arg-type]

    assert client.list_downloads() == []
    assert len(session.calls) == 2
    assert sleeps == [3.0]


def test_queue_5xx_retries_once_after_five_seconds() -> None:
    session = FakeSession([
        FakeResponse({"status": 0, "message": "temporary"}, status_code=503),
        FakeResponse({"status": 1, "message": "success", "data": {"list": []}}),
    ])
    sleeps: list[float] = []
    client = YacangClient(session, production_guard=_guard(), sleep=sleeps.append)  # type: ignore[arg-type]

    assert client.list_downloads() == []
    assert len(session.calls) == 2
    assert sleeps == [5.0]


@pytest.mark.parametrize("status", [403, 429])
def test_risk_http_status_stops_without_retry(status: int) -> None:
    session = FakeSession([
        FakeResponse({"status": 0, "message": "blocked"}, status_code=status),
    ])
    cooldown = MemoryCooldownStore()
    guard = YacangProductionGuard(
        enabled=True,
        cooldown=cooldown,
        request_gate=MemoryRequestGate(),
    )
    client = YacangClient(session, production_guard=guard, sleep=lambda _seconds: None)  # type: ignore[arg-type]

    with pytest.raises(YacangError) as caught:
        client.list_downloads()

    assert len(session.calls) == 1
    assert caught.value.http_status == status
    assert caught.value.scope == "global"
    assert cooldown.remaining_seconds() == (900 if status == 429 else 0)


def test_429_cooldown_is_active_before_global_request_slot_is_released() -> None:
    session = FakeSession([
        FakeResponse({"status": 0, "message": "blocked"}, status_code=429),
    ])
    cooldown = MemoryCooldownStore()
    gate = CooldownObservingGate(cooldown)
    guard = YacangProductionGuard(enabled=True, cooldown=cooldown, request_gate=gate)
    client = YacangClient(session, production_guard=guard)  # type: ignore[arg-type]

    with pytest.raises(YacangError):
        client.list_downloads()

    assert gate.remaining_when_released == 900


def test_malformed_queue_response_is_status_unknown() -> None:
    session = FakeSession([
        FakeResponse({"status": 1, "message": "success", "data": {"unexpected": []}}),
    ])
    client = YacangClient(session, production_guard=_guard())  # type: ignore[arg-type]

    with pytest.raises(YacangError) as caught:
        client.list_downloads()

    assert caught.value.code == "EXPORT_STATUS_UNKNOWN"
    assert caught.value.scope == "global"


@pytest.mark.parametrize(
    "rows",
    [
        ["not-an-object"],
        [{"name": "库存动销导出", "type": "10"}],
    ],
)
def test_malformed_queue_rows_are_status_unknown(rows: list[Any]) -> None:
    session = FakeSession([
        FakeResponse({"status": 1, "message": "success", "data": {"list": rows}}),
    ])
    client = YacangClient(session, production_guard=_guard())  # type: ignore[arg-type]
    with pytest.raises(YacangError) as caught:
        client.list_downloads()
    assert caught.value.code == "EXPORT_STATUS_UNKNOWN"
    assert caught.value.scope == "global"


def test_production_disabled_blocks_before_session_call() -> None:
    session = FakeSession([])
    client = YacangClient(
        session,
        production_guard=YacangProductionGuard(
            enabled=False,
            cooldown=MemoryCooldownStore(),
            request_gate=MemoryRequestGate(),
        ),
    )  # type: ignore[arg-type]

    with pytest.raises(YacangError) as caught:
        client.list_downloads()

    assert caught.value.code == "YACANG_PROD_DISABLED"
    assert session.calls == []


def test_captcha_request_failure_is_not_retried() -> None:
    session = FakeSession([requests.Timeout("captcha timeout")])
    client = YacangClient(session, production_guard=_guard(), sleep=lambda _seconds: None)  # type: ignore[arg-type]
    with pytest.raises(YacangError) as caught:
        client.login("account", "password")
    assert caught.value.code == "YACANG_NETWORK_ERROR"
    assert len(session.calls) == 1


def test_missing_captcha_code_stops_before_login() -> None:
    session = FakeSession([
        FakeResponse({"status": 1, "message": "success", "data": {"key": "fixture"}}),
    ])
    client = YacangClient(session, production_guard=_guard())  # type: ignore[arg-type]
    with pytest.raises(YacangError) as caught:
        client.login("account", "password")
    assert caught.value.code == "YACANG_CAPTCHA_INVALID"
    assert len(session.calls) == 1


def test_login_success_without_token_is_rejected_without_retry() -> None:
    session = FakeSession([
        FakeResponse({
            "status": 1,
            "message": "success",
            "data": {"key": "fixture", "code": "1234"},
        }),
        FakeResponse({"status": 1, "message": "success", "data": {}}),
    ])
    client = YacangClient(session, production_guard=_guard())  # type: ignore[arg-type]
    with pytest.raises(YacangError) as caught:
        client.login("account", "password")
    assert caught.value.code == "YACANG_TOKEN_INVALID"
    assert len(session.calls) == 2


def test_raw_invalid_json_error_redacts_quoted_sensitive_fields() -> None:
    detail = safe_remote_detail(
        '{"token":"opaque-secret","password": "private-password","message":"invalid"}'
    )
    assert "opaque-secret" not in detail
    assert "private-password" not in detail
    assert "invalid" in detail
