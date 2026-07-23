from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

import requests
import pytest
from openpyxl import Workbook

from services.agent_cli.mabang import erp_http
from services.agent_cli.mabang import erp_opening_inventory_import as cli


class FakeResponse:
    def __init__(self, status_code: int, payload: Any, text: str = "") -> None:
        self.status_code = status_code
        self._payload = payload
        self.text = text or json.dumps(payload, ensure_ascii=False)

    def json(self) -> Any:
        return self._payload


class FakeSession:
    def __init__(self, responses: list[FakeResponse] | None = None) -> None:
        self.responses = list(responses or [])
        self.calls: list[dict[str, Any]] = []
        self.error: Exception | None = None

    def request(self, method: str, url: str, **kwargs: Any) -> FakeResponse:
        self.calls.append({"method": method, "url": url, **kwargs})
        if self.error is not None:
            raise self.error
        return self.responses.pop(0)


def _write_inventory(path: Path, rows: list[list[Any]], *, headers: tuple[str, ...] = cli.EXPECTED_HEADERS) -> None:
    workbook = Workbook()
    worksheet = workbook.active
    worksheet.append(list(headers))
    for row in rows:
        worksheet.append(row)
    workbook.save(path)


def _configure(monkeypatch, *, api_key: str = "erp-secret") -> None:
    monkeypatch.setenv("LXE_DATA_SERVER_URL", "http://10.88.0.1:8000/")
    if api_key:
        monkeypatch.setenv("LXE_ERP_API_KEY", api_key)
    else:
        monkeypatch.delenv("LXE_ERP_API_KEY", raising=False)
    monkeypatch.setenv("LXE_DATA_SERVER_REQUEST_TIMEOUT_SECONDS", "12")


def test_preview_strictly_parses_six_columns_and_preserves_confirmation(monkeypatch, tmp_path: Path) -> None:
    _configure(monkeypatch)
    source = tmp_path / "opening.xlsx"
    _write_inventory(
        source,
        [
            ["正飞", "ZF20260601001", "SP260601001 扣库存", "A-1", 3.5, 4],
            ["正飞", "历史合同", "SP260601002", "A-2", 4, 2],
        ],
    )
    detail = {
        "code": "opening_inventory_confirmation_required",
        "message": "opening inventory preview is ready; confirmation is required",
        "row_count": 2,
        "total_quantity": 6,
        "supplier_count": 1,
        "model_count": 2,
        "warnings": [{"row_no": 3, "code": "opening_inventory_acquired_date_missing"}],
    }
    session = FakeSession([FakeResponse(409, {"detail": detail})])
    monkeypatch.setattr(erp_http, "local_service_requests_session", session)

    result = cli.run({"input_xlsx": str(source)})

    assert result["success"] is False
    assert result["status"] == "confirmation_required"
    assert result["error"]["code"] == detail["code"]
    assert result["error"]["http_status"] == 409
    assert result["preview"] == detail
    posted = session.calls[0]
    assert posted["url"] == "http://10.88.0.1:8000/api/v1/erp/opening-inventory/import"
    assert posted["timeout"] == 12
    assert posted["json"]["lines"] == [
        {
            "row_no": 2,
            "supplier_name": "正飞",
            "contract_no": "ZF20260601001",
            "source_reference": "SP260601001 扣库存",
            "source_sp_no": "SP260601001",
            "model": "A-1",
            "historical_tax_unit_price": "3.5",
            "remaining_quantity": "4",
            "acquired_on": "2026-06-01",
        },
        {
            "row_no": 3,
            "supplier_name": "正飞",
            "contract_no": "历史合同",
            "source_reference": "SP260601002",
            "source_sp_no": "SP260601002",
            "model": "A-2",
            "historical_tax_unit_price": "4",
            "remaining_quantity": "2",
            "acquired_on": None,
        },
    ]
    assert posted["json"]["source_sha256"] == hashlib.sha256(source.read_bytes()).hexdigest()
    assert "erp-secret" not in json.dumps(result, ensure_ascii=False)


def test_confirm_sends_digest_and_request_id_is_stable(monkeypatch, tmp_path: Path) -> None:
    _configure(monkeypatch)
    source = tmp_path / "opening.xlsx"
    _write_inventory(source, [["正飞", "ZF20260601001", "SP260601001", "A-1", 3.5, 4]])
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    session = FakeSession(
        [
            FakeResponse(201, {"status": "created", "import_id": "opening-1"}),
            FakeResponse(200, {"status": "idempotent", "import_id": "opening-1"}),
        ]
    )
    monkeypatch.setattr(erp_http, "local_service_requests_session", session)

    first = cli.run({"input_xlsx": str(source), "confirm_source_sha256": digest})
    second = cli.run({"input_xlsx": str(source), "confirm_source_sha256": digest})

    assert first["success"] is True
    assert second["success"] is True
    assert session.calls[0]["json"]["confirm_source_sha256"] == digest
    assert session.calls[0]["json"]["request_id"] == session.calls[1]["json"]["request_id"]


def test_invalid_headers_or_quantity_fail_before_http(monkeypatch, tmp_path: Path) -> None:
    _configure(monkeypatch)
    source = tmp_path / "opening.xlsx"
    _write_inventory(
        source,
        [["正飞", "ZF20260601001", "SP260601001", "A-1", 3.5, 0]],
        headers=("供应商", "合同号", "订单号", "型号", "含税单价", "数量"),
    )
    session = FakeSession()
    monkeypatch.setattr(erp_http, "local_service_requests_session", session)

    result = cli.run({"input_xlsx": str(source)})

    assert result["success"] is False
    assert result["error"]["code"] == "opening_inventory_workbook_invalid"
    assert "表头必须严格为" in result["error"]["message"]
    assert session.calls == []


def test_missing_credentials_and_transport_error_are_truthful(monkeypatch, tmp_path: Path) -> None:
    source = tmp_path / "opening.xlsx"
    _write_inventory(source, [["正飞", "ZF20260601001", "SP260601001", "A-1", 3.5, 4]])
    _configure(monkeypatch, api_key="")
    session = FakeSession()
    monkeypatch.setattr(erp_http, "local_service_requests_session", session)

    missing = cli.run({"input_xlsx": str(source)})

    assert missing["error"]["code"] == "erp_credentials_not_configured"
    assert session.calls == []

    _configure(monkeypatch)
    session.error = requests.Timeout("private ERP timed out after 12 seconds")
    failed = cli.run({"input_xlsx": str(source)})
    assert failed["error"]["code"] == "erp_transport_error"
    assert "private ERP timed out after 12 seconds" in failed["error"]["message"]


def test_remote_error_preserves_real_detail(monkeypatch, tmp_path: Path) -> None:
    _configure(monkeypatch)
    source = tmp_path / "opening.xlsx"
    _write_inventory(source, [["正飞", "ZF20260601001", "SP260601001", "A-1", 3.5, 4]])
    detail = {
        "code": "opening_inventory_already_initialized",
        "message": "opening inventory was already initialized from another workbook",
        "existing_source_sha256": "a" * 64,
    }
    session = FakeSession([FakeResponse(409, {"detail": detail})])
    monkeypatch.setattr(erp_http, "local_service_requests_session", session)

    result = cli.run({"input_xlsx": str(source)})

    assert result["success"] is False
    assert result["error"] == {
        "code": detail["code"],
        "message": detail["message"],
        "http_status": 409,
        "detail": detail,
    }


@pytest.mark.parametrize(
    ("response", "expected_code", "message_fragment"),
    [
        (
            FakeResponse(
                401,
                {"detail": {"code": "erp_authentication_failed", "message": "ERP API key rejected"}},
            ),
            "erp_authentication_failed",
            "ERP API key rejected",
        ),
        (
            FakeResponse(503, {"detail": "database temporarily unavailable"}),
            "erp_http_503",
            "database temporarily unavailable",
        ),
    ],
)
def test_http_status_and_real_body_are_preserved(
    monkeypatch,
    tmp_path: Path,
    response: FakeResponse,
    expected_code: str,
    message_fragment: str,
) -> None:
    _configure(monkeypatch)
    source = tmp_path / "opening.xlsx"
    _write_inventory(source, [["正飞", "ZF20260601001", "SP260601001", "A-1", 3.5, 4]])
    session = FakeSession([response])
    monkeypatch.setattr(erp_http, "local_service_requests_session", session)

    result = cli.run({"input_xlsx": str(source)})

    assert result["success"] is False
    assert result["error"]["code"] == expected_code
    assert result["error"]["http_status"] == response.status_code
    assert message_fragment in result["error"]["message"]
