from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import pandas as pd
import requests

from services.agent_cli.mabang import erp_packing_upload as cli


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


def _write_packing(path: Path, rows: list[dict[str, object]]) -> None:
    pd.DataFrame(rows).to_excel(path, sheet_name="FBA装箱任务", index=False)


def _configure(
    monkeypatch,
    tmp_path: Path,
    *,
    api_key: str = "erp-secret",
) -> None:
    monkeypatch.setattr(cli, "resolve_consignment_excel_dir", lambda: tmp_path)
    monkeypatch.setenv("LXE_DATA_SERVER_URL", "http://10.88.0.1:8000/")
    if api_key:
        monkeypatch.setenv("LXE_ERP_API_KEY", api_key)
    else:
        monkeypatch.delenv("LXE_ERP_API_KEY", raising=False)


def _preview_response(
    *,
    status: str = "confirmation_required",
    lines: list[dict[str, Any]] | None = None,
) -> FakeResponse:
    payload: dict[str, Any] = {
        "response_schema": "lxe.erp.packing-preview.v1",
        "status": status,
        "request_id": "packing-SP260710001-preview",
        "quote_id": "00000000-0000-0000-0000-000000000010",
        "action": "create",
        "sp_no": "SP260710001",
        "batch_id": "00000000-0000-0000-0000-000000000002",
        "batch_no": "PB260710001",
        "proposed_version_no": 1,
        "inventory_changes_committed": False,
        "snapshot_changes_committed": False,
        "reconciliation_status": "mismatch",
        "summary": {
            "planned_quantity": 30,
            "actual_quantity": 20,
            "difference_quantity": -10,
            "carryover_quantity": 10,
            "incomplete_issue_count": 0,
        },
        "reconciliation_lines": lines or [],
        "proposed_carryovers": [
            {
                "carryover_kind": "packing_new",
                "stock_sku": "SKU-A",
                "supplier_name": "正飞供应商",
                "source_contract_no": "ZF20260710001",
                "source_sp_no": "SP260710001",
                "model": "M-1",
                "tax_unit_price": 3.25,
                "quantity": 10,
            }
        ],
    }
    if status == "quote_stale":
        payload["error"] = {
            "code": "packing_snapshot_quote_stale",
            "message": "review the latest preview",
        }
    return FakeResponse(409, payload)


def _created_response() -> FakeResponse:
    return FakeResponse(
        201,
        {
            "response_schema": "lxe.erp.packing-preview.v1",
            "status": "created",
            "action": "create",
            "snapshot_id": "00000000-0000-0000-0000-000000000001",
            "version_no": 1,
            "sp_no": "SP260710001",
            "batch_id": "00000000-0000-0000-0000-000000000002",
            "batch_no": "PB260710001",
            "reconciliation_id": "00000000-0000-0000-0000-000000000003",
            "reconciliation_status": "mismatch",
            "inventory_changes_committed": True,
            "snapshot_changes_committed": True,
            "summary": {
                "planned_quantity": 30,
                "actual_quantity": 20,
                "difference_quantity": -10,
                "carryover_quantity": 10,
                "incomplete_issue_count": 0,
            },
            "carryover_lines": [],
        },
    )


def test_preview_uses_latest_exact_original_file_and_aggregates_msku(
    monkeypatch,
    tmp_path: Path,
) -> None:
    _configure(monkeypatch, tmp_path)
    old = tmp_path / "SP260710001.xls"
    old.write_bytes(b"stale")
    os.utime(old, (1, 1))
    source = tmp_path / "SP260710001.xlsx"
    _write_packing(
        source,
        [
            {"MSKU": "msku-a", "装箱数量": 3},
            {"MSKU": "MSKU-A", "装箱数量": 5},
            {"MSKU": "MSKU-B", "装箱数量": 12},
        ],
    )
    _write_packing(
        tmp_path / "SP260710001-1.xlsx",
        [{"MSKU": "WRONG", "装箱数量": 999}],
    )
    detail_lines = [
        {"stock_sku": f"SKU-{index}", "status": "shortage"}
        for index in range(205)
    ]
    session = FakeSession([_preview_response(lines=detail_lines)])
    monkeypatch.setattr(cli, "local_service_requests_session", session)

    result = cli.run({"ship_no": "sp260710001"})

    assert result["success"] is True
    assert result["confirmation_required"] is True
    assert result["source_file_path"] == str(source)
    assert result["msku_count"] == 2
    assert result["actual_msku_quantity"] == "20"
    assert result["reconciliation_line_count"] == 205
    assert len(result["reconciliation_lines"]) == 200
    assert result["reconciliation_lines_truncated"] == 5
    posted = session.calls[0]
    assert posted["url"].endswith("/api/v1/erp/packing-snapshots/preview")
    assert posted["json"]["lines"] == [
        {"msku": "MSKU-A", "actual_quantity": "8"},
        {"msku": "MSKU-B", "actual_quantity": "12"},
    ]
    assert "erp-secret" not in json.dumps(result, ensure_ascii=False)


def test_direct_attachment_takes_precedence_and_infers_ship_no(
    monkeypatch,
    tmp_path: Path,
) -> None:
    _configure(monkeypatch, tmp_path)
    fallback = tmp_path / "SP260710999.xlsx"
    _write_packing(fallback, [{"MSKU": "WRONG", "装箱数量": 99}])
    attached = tmp_path / "SP260710001.xlsx"
    _write_packing(attached, [{"MSKU": "MSKU-A", "装箱数量": 8}])
    session = FakeSession([_preview_response()])
    monkeypatch.setattr(cli, "local_service_requests_session", session)

    result = cli.run({"packing_excel": str(attached)})

    assert result["success"] is True
    assert result["ship_no"] == "SP260710001"
    assert session.calls[0]["json"]["sp_no"] == "SP260710001"


def test_direct_attachment_rejects_split_and_ship_mismatch(
    monkeypatch,
    tmp_path: Path,
) -> None:
    _configure(monkeypatch, tmp_path)
    split = tmp_path / "SP260710001-1.xlsx"
    _write_packing(split, [{"MSKU": "MSKU-A", "装箱数量": 8}])
    original = tmp_path / "SP260710001.xlsx"
    _write_packing(original, [{"MSKU": "MSKU-A", "装箱数量": 8}])

    rejected_split = cli.run({"packing_excel": str(split)})
    mismatch = cli.run(
        {"packing_excel": str(original), "ship_no": "SP260710002"}
    )

    assert rejected_split["error"]["code"] == "packing_file_not_original"
    assert mismatch["error"]["code"] == "packing_file_ship_no_mismatch"


def test_xls_extension_is_allowed_for_original_attachment(tmp_path: Path) -> None:
    source = tmp_path / "SP260710001.xls"
    source.write_bytes(b"xls fixture")

    resolved, ship_no = cli._direct_packing_file(source, "")

    assert resolved == source.resolve()
    assert ship_no == "SP260710001"


def test_request_id_is_deterministic_for_same_source(monkeypatch, tmp_path: Path) -> None:
    _configure(monkeypatch, tmp_path)
    source = tmp_path / "SP260710001.xlsx"
    _write_packing(source, [{"MSKU": "MSKU-A", "装箱数量": 8}])
    session = FakeSession([_preview_response(), _preview_response()])
    monkeypatch.setattr(cli, "local_service_requests_session", session)

    first = cli.run({"ship_no": "SP260710001"})
    second = cli.run({"ship_no": "SP260710001"})

    assert first["request_id"] == second["request_id"]
    assert session.calls[0]["json"]["request_id"] == session.calls[1]["json"]["request_id"]


def test_confirmation_only_sends_quote_id(monkeypatch, tmp_path: Path) -> None:
    _configure(monkeypatch, tmp_path)
    session = FakeSession(
        [_created_response(), FakeResponse(200, {"lines": []})]
    )
    monkeypatch.setattr(cli, "local_service_requests_session", session)
    quote_id = "00000000-0000-0000-0000-000000000010"

    result = cli.run({"confirm_packing_quote_id": quote_id})

    assert result["success"] is True
    assert result["status"] == "created"
    assert session.calls[0]["url"].endswith("/api/v1/erp/packing-snapshots/confirm")
    assert session.calls[0]["json"]["quote_id"] == quote_id
    assert set(session.calls[0]["json"]) == {"request_id", "quote_id"}


def test_stale_confirmation_returns_latest_preview(monkeypatch, tmp_path: Path) -> None:
    _configure(monkeypatch, tmp_path)
    session = FakeSession([_preview_response(status="quote_stale")])
    monkeypatch.setattr(cli, "local_service_requests_session", session)

    result = cli.run(
        {"confirm_packing_quote_id": "00000000-0000-0000-0000-000000000009"}
    )

    assert result["success"] is True
    assert result["status"] == "quote_stale"
    assert result["confirmation_required"] is True
    assert result["quote_id"] == "00000000-0000-0000-0000-000000000010"


def test_missing_file_returns_original_download_recovery(monkeypatch, tmp_path: Path) -> None:
    _configure(monkeypatch, tmp_path)
    session = FakeSession()
    monkeypatch.setattr(cli, "local_service_requests_session", session)

    result = cli.run({"ship_no": "SP260710001"})

    assert result["success"] is False
    assert result["error"]["code"] == "packing_file_missing"
    assert result["recovery"]["skill"] == "fba-shipment-wms-box-download"
    assert session.calls == []


def test_missing_erp_credentials_is_explicit(monkeypatch, tmp_path: Path) -> None:
    _configure(monkeypatch, tmp_path, api_key="")
    _write_packing(
        tmp_path / "SP260710001.xlsx",
        [{"MSKU": "MSKU-A", "装箱数量": 8}],
    )
    session = FakeSession()
    monkeypatch.setattr(cli, "local_service_requests_session", session)

    result = cli.run({"ship_no": "SP260710001"})

    assert result["error"]["code"] == "erp_credentials_not_configured"
    assert session.calls == []


def test_transport_error_keeps_real_exception(monkeypatch, tmp_path: Path) -> None:
    _configure(monkeypatch, tmp_path)
    _write_packing(
        tmp_path / "SP260710001.xlsx",
        [{"MSKU": "MSKU-A", "装箱数量": 8}],
    )
    session = FakeSession()
    session.error = requests.Timeout("private ERP timed out after 12 seconds")
    monkeypatch.setattr(cli, "local_service_requests_session", session)

    result = cli.run({"ship_no": "SP260710001"})

    assert result["error"]["code"] == "erp_transport_error"
    assert "private ERP timed out after 12 seconds" in result["error"]["message"]


def test_invalid_packing_columns_preserve_parser_error(monkeypatch, tmp_path: Path) -> None:
    _configure(monkeypatch, tmp_path)
    _write_packing(
        tmp_path / "SP260710001.xlsx",
        [{"MSKU": "MSKU-A", "错误数量列": 8}],
    )

    result = cli.run({"ship_no": "SP260710001"})

    assert result["error"]["code"] == "packing_upload_failed"
    assert "装箱数量" in result["error"]["message"]
