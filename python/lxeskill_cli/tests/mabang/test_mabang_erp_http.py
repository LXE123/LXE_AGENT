from __future__ import annotations

import json
from typing import Any

import pytest
import requests

from services.agent_cli.mabang import erp_http


class FakeResponse:
    def __init__(
        self,
        status_code: int,
        payload: Any,
        *,
        text: str | None = None,
        content: bytes = b"",
        headers: dict[str, str] | None = None,
        json_error: Exception | None = None,
    ) -> None:
        self.status_code = status_code
        self._payload = payload
        self.text = text if text is not None else json.dumps(payload, ensure_ascii=False)
        self.content = content
        self.headers = dict(headers or {})
        self._json_error = json_error

    def json(self) -> Any:
        if self._json_error is not None:
            raise self._json_error
        return self._payload


class FakeSession:
    def __init__(self, responses: list[FakeResponse] | None = None) -> None:
        self.responses = list(responses or [])
        self.calls: list[dict[str, Any]] = []
        self.error: requests.RequestException | None = None

    def request(self, method: str, url: str, **kwargs: Any) -> FakeResponse:
        self.calls.append({"method": method, "url": url, **kwargs})
        if self.error is not None:
            raise self.error
        return self.responses.pop(0)


@pytest.fixture(autouse=True)
def _configure(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LXE_DATA_SERVER_URL", "http://10.88.0.1:8000")
    monkeypatch.setenv("LXE_ERP_API_KEY", "current-exact-api-key")
    monkeypatch.setenv("LXE_DATA_SERVER_REQUEST_TIMEOUT_SECONDS", "9")


def _serialized_error(exc: erp_http.ErpHttpError) -> str:
    return json.dumps(
        {
            "message": str(exc),
            "detail": exc.detail,
            "payload": exc.payload,
        },
        ensure_ascii=False,
    )


def test_json_error_redacts_secrets_and_explicitly_truncates_nested_values(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    malicious_message = (
        "Authorization: Bearer bearer-danger "
        "password=hunter2 "
        "api_key=current-exact-api-key "
        + ("x" * 5_000)
    )
    payload = {
        "detail": {
            "code": "erp_backend_failed",
            "message": malicious_message,
            "nested": {
                "secret": "nested-secret",
                "refresh_token": "refresh-danger",
                "echo": "current-exact-api-key",
            },
        },
        "echoed_authorization": "Bearer payload-danger",
    }
    session = FakeSession([FakeResponse(503, payload)])
    monkeypatch.setattr(erp_http, "local_service_requests_session", session)

    with pytest.raises(erp_http.ErpHttpError) as captured:
        erp_http.request_json("POST", "/api/v1/erp/test", operation="测试 ERP")

    serialized = _serialized_error(captured.value)
    for secret in (
        "current-exact-api-key",
        "bearer-danger",
        "hunter2",
        "nested-secret",
        "refresh-danger",
        "payload-danger",
    ):
        assert secret not in serialized
    assert "[REDACTED]" in serialized
    assert "[truncated " in serialized
    assert captured.value.http_status == 503
    assert captured.value.code == "erp_backend_failed"


def test_invalid_json_body_and_transport_exception_are_redacted(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    response = FakeResponse(
        502,
        None,
        text=(
            "upstream dumped api_key=current-exact-api-key "
            "Authorization: Bearer body-token "
            + ("z" * 5_000)
        ),
        json_error=ValueError("not json"),
    )
    session = FakeSession([response])
    monkeypatch.setattr(erp_http, "local_service_requests_session", session)

    with pytest.raises(erp_http.ErpHttpError) as invalid_json:
        erp_http.request_json("GET", "/api/v1/erp/test", operation="读取 ERP")

    message = str(invalid_json.value)
    assert "current-exact-api-key" not in message
    assert "body-token" not in message
    assert "[REDACTED]" in message
    assert "[truncated " in message
    assert len(message) <= erp_http.MAX_REMOTE_BODY_CHARS + 100

    session.error = requests.Timeout(
        "request failed: token=transport-token; api_key=current-exact-api-key"
    )
    with pytest.raises(erp_http.ErpHttpError) as transport:
        erp_http.request_json("GET", "/api/v1/erp/test", operation="读取 ERP")

    transport_message = str(transport.value)
    assert transport.value.code == "erp_transport_error"
    assert "transport-token" not in transport_message
    assert "current-exact-api-key" not in transport_message
    assert transport_message.count("[REDACTED]") >= 2


def test_success_payload_is_sanitized_without_truncating_business_collections(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    payload = {
        "status": "ok",
        "echo": "current-exact-api-key",
        "items": ["safe"] * (erp_http.MAX_REMOTE_SEQUENCE_ITEMS + 3),
        "mapping": {
            f"key-{index}": index
            for index in range(erp_http.MAX_REMOTE_MAPPING_ITEMS + 2)
        },
    }
    session = FakeSession([FakeResponse(200, payload)])
    monkeypatch.setattr(erp_http, "local_service_requests_session", session)

    status, result = erp_http.request_json(
        "GET",
        "/api/v1/erp/test",
        operation="读取 ERP",
    )

    assert status == 200
    assert result["echo"] == "[REDACTED]"
    assert len(result["items"]) == erp_http.MAX_REMOTE_SEQUENCE_ITEMS + 3
    assert result["items"][-1] == "safe"
    assert len(result["mapping"]) == erp_http.MAX_REMOTE_MAPPING_ITEMS + 2
    assert "_truncated_mapping_items" not in result["mapping"]


def test_error_payload_collections_remain_explicitly_bounded(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    payload = {
        "detail": {
            "code": "erp_backend_failed",
            "message": "backend failed",
            "items": ["safe"] * (erp_http.MAX_REMOTE_SEQUENCE_ITEMS + 3),
        }
    }
    session = FakeSession([FakeResponse(503, payload)])
    monkeypatch.setattr(erp_http, "local_service_requests_session", session)

    with pytest.raises(erp_http.ErpHttpError) as captured:
        erp_http.request_json("GET", "/api/v1/erp/test", operation="读取 ERP")

    assert captured.value.detail["items"][-1] == {"_truncated_sequence_items": 3}


def test_accepted_business_conflict_preserves_complete_payload(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    payload = {
        "error": {
            "code": "purchase_inventory_confirmation_required",
            "message": "confirmation required",
        },
        "lines": ["safe"] * (erp_http.MAX_REMOTE_SEQUENCE_ITEMS + 3),
    }
    session = FakeSession([FakeResponse(409, payload)])
    monkeypatch.setattr(erp_http, "local_service_requests_session", session)

    status, result = erp_http.request_json(
        "POST",
        "/api/v1/erp/purchase-batches/import",
        operation="导入采购批次",
        accepted_error_codes=frozenset(
            {"purchase_inventory_confirmation_required"}
        ),
    )

    assert status == 409
    assert len(result["lines"]) == erp_http.MAX_REMOTE_SEQUENCE_ITEMS + 3
    assert result["lines"][-1] == "safe"


def test_request_bytes_returns_exact_file_and_sanitized_headers(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    workbook_bytes = b"PK\x03\x04fake-xlsx"
    session = FakeSession(
        [
            FakeResponse(
                200,
                None,
                content=workbook_bytes,
                headers={
                    "Content-Disposition": (
                        "attachment; filename*=UTF-8''%E5%90%88%E5%90%8C.xlsx"
                    ),
                    "X-Debug": "Authorization: Bearer header-token",
                },
            )
        ]
    )
    monkeypatch.setattr(erp_http, "local_service_requests_session", session)

    status, content, headers = erp_http.request_bytes(
        "GET",
        "/api/v1/erp/contracts/contract-1/download",
        operation="下载合同",
    )

    assert status == 200
    assert content == workbook_bytes
    assert headers["Content-Disposition"].endswith("%E5%90%8C.xlsx")
    assert "header-token" not in headers["X-Debug"]
    assert "[REDACTED]" in headers["X-Debug"]
    assert session.calls[0]["headers"]["Authorization"] == (
        "Bearer current-exact-api-key"
    )
    assert session.calls[0]["timeout"] == 9


def test_request_bytes_preserves_truthful_sanitized_json_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    payload = {
        "detail": {
            "code": "contract_not_found",
            "message": (
                "contract missing; password=server-password; "
                "echo=current-exact-api-key"
            ),
        }
    }
    session = FakeSession([FakeResponse(404, payload)])
    monkeypatch.setattr(erp_http, "local_service_requests_session", session)

    with pytest.raises(erp_http.ErpHttpError) as captured:
        erp_http.request_bytes(
            "GET",
            "/api/v1/erp/contracts/missing/download",
            operation="下载合同",
        )

    assert captured.value.code == "contract_not_found"
    assert captured.value.http_status == 404
    assert "server-password" not in _serialized_error(captured.value)
    assert "current-exact-api-key" not in _serialized_error(captured.value)
    assert "contract missing" in str(captured.value)
