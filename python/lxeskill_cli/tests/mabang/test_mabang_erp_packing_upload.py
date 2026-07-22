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
    monkeypatch.setenv("LXE_DATA_SERVER_REQUEST_TIMEOUT_SECONDS", "12")


def _upload_response(*, status: str = "created") -> FakeResponse:
    return FakeResponse(
        200 if status == "unchanged" else 201,
        {
            "status": status,
            "snapshot_id": "00000000-0000-0000-0000-000000000001",
            "version_no": 1,
            "sp_no": "SP260710001",
            "batch_id": "00000000-0000-0000-0000-000000000002",
            "batch_no": "PB260710001",
            "reconciliation_id": "00000000-0000-0000-0000-000000000003",
            "reconciliation_status": "mismatch",
            "summary": {
                "planned_quantity": 30,
                "actual_quantity": 20,
                "difference_quantity": -10,
                "carryover_quantity": 10,
                "incomplete_issue_count": 0,
            },
        },
    )


def test_upload_uses_latest_exact_original_file_and_aggregates_msku(
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
    split = tmp_path / "SP260710001-1.xlsx"
    _write_packing(split, [{"MSKU": "WRONG", "装箱数量": 999}])
    os.utime(split, (source.stat().st_mtime + 100, source.stat().st_mtime + 100))
    detail_lines = [
        {"stock_sku": f"SKU-{index}", "status": "shortage"}
        for index in range(205)
    ]
    session = FakeSession(
        [
            _upload_response(),
            FakeResponse(200, {"lines": detail_lines}),
        ]
    )
    monkeypatch.setattr(cli, "local_service_requests_session", session)

    result = cli.run({"ship_no": "sp260710001"})

    assert result["success"] is True
    assert result["source_file_path"] == str(source)
    assert result["msku_count"] == 2
    assert result["actual_msku_quantity"] == "20"
    assert result["reconciliation_status"] == "mismatch"
    assert result["needs_attention"] is True
    assert result["reconciliation_line_count"] == 205
    assert len(result["reconciliation_lines"]) == 200
    assert result["reconciliation_lines_truncated"] == 5
    posted = session.calls[0]
    assert posted["url"] == "http://10.88.0.1:8000/api/v1/erp/packing-snapshots/import"
    assert posted["timeout"] == 12
    assert posted["json"]["lines"] == [
        {"msku": "MSKU-A", "actual_quantity": "8"},
        {"msku": "MSKU-B", "actual_quantity": "12"},
    ]
    assert posted["json"]["source_file_name"] == "SP260710001.xlsx"
    assert "erp-secret" not in json.dumps(result, ensure_ascii=False)


def test_request_id_is_deterministic_for_the_same_source(
    monkeypatch,
    tmp_path: Path,
) -> None:
    _configure(monkeypatch, tmp_path)
    source = tmp_path / "SP260710001.xlsx"
    _write_packing(source, [{"MSKU": "MSKU-A", "装箱数量": 8}])
    session = FakeSession(
        [
            _upload_response(),
            FakeResponse(200, {"lines": []}),
            _upload_response(status="unchanged"),
            FakeResponse(200, {"lines": []}),
        ]
    )
    monkeypatch.setattr(cli, "local_service_requests_session", session)

    first = cli.run({"ship_no": "SP260710001"})
    second = cli.run({"ship_no": "SP260710001"})

    assert first["request_id"] == second["request_id"]
    assert session.calls[0]["json"]["request_id"] == session.calls[2]["json"]["request_id"]


def test_missing_file_returns_original_download_recovery(monkeypatch, tmp_path: Path) -> None:
    _configure(monkeypatch, tmp_path)
    session = FakeSession()
    monkeypatch.setattr(cli, "local_service_requests_session", session)

    result = cli.run({"ship_no": "SP260710001"})

    assert result["success"] is False
    assert result["error"]["code"] == "packing_file_missing"
    assert result["recovery"] == {
        "next_action": "ask_user_to_download_original_wms",
        "skill": "fba-shipment-wms-box-download",
        "command": (
            "lxeskill fba shipment wms-box-download "
            "--ship-no SP260710001 --split-mode original"
        ),
    }
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

    assert result["success"] is False
    assert result["error"]["code"] == "erp_credentials_not_configured"
    assert session.calls == []


def test_replacement_confirmation_error_preserves_server_diff(
    monkeypatch,
    tmp_path: Path,
) -> None:
    _configure(monkeypatch, tmp_path)
    _write_packing(
        tmp_path / "SP260710001.xlsx",
        [{"MSKU": "MSKU-A", "装箱数量": 9}],
    )
    detail = {
        "code": "packing_snapshot_replace_confirmation_required",
        "message": "packing quantities differ from the current snapshot; confirmation is required",
        "current_snapshot_id": "00000000-0000-0000-0000-000000000001",
        "current_version_no": 1,
        "changes": [
            {
                "msku": "MSKU-A",
                "change_type": "quantity_changed",
                "current_quantity": 8,
                "incoming_quantity": 9,
            }
        ],
    }
    session = FakeSession([FakeResponse(409, {"detail": detail})])
    monkeypatch.setattr(cli, "local_service_requests_session", session)

    result = cli.run({"ship_no": "SP260710001"})

    assert result["success"] is False
    assert result["error"]["code"] == detail["code"]
    assert result["error"]["http_status"] == 409
    assert result["error"]["detail"] == detail


def test_confirmed_replacement_sends_snapshot_id(monkeypatch, tmp_path: Path) -> None:
    _configure(monkeypatch, tmp_path)
    _write_packing(
        tmp_path / "SP260710001.xlsx",
        [{"MSKU": "MSKU-A", "装箱数量": 9}],
    )
    session = FakeSession([_upload_response(), FakeResponse(200, {"lines": []})])
    monkeypatch.setattr(cli, "local_service_requests_session", session)
    snapshot_id = "00000000-0000-0000-0000-000000000001"

    result = cli.run(
        {
            "ship_no": "SP260710001",
            "confirm_replace_snapshot_id": snapshot_id,
        }
    )

    assert result["success"] is True
    assert session.calls[0]["json"]["confirm_replace_snapshot_id"] == snapshot_id


def test_reconciliation_detail_failure_does_not_hide_successful_upload(
    monkeypatch,
    tmp_path: Path,
) -> None:
    _configure(monkeypatch, tmp_path)
    _write_packing(
        tmp_path / "SP260710001.xlsx",
        [{"MSKU": "MSKU-A", "装箱数量": 8}],
    )
    session = FakeSession(
        [
            _upload_response(),
            FakeResponse(503, {"detail": "reconciliation query temporarily unavailable"}),
        ]
    )
    monkeypatch.setattr(cli, "local_service_requests_session", session)

    result = cli.run({"ship_no": "SP260710001"})

    assert result["success"] is True
    assert result["snapshot_id"] == "00000000-0000-0000-0000-000000000001"
    assert result["needs_attention"] is True
    assert result["reconciliation_detail_error"] == {
        "code": "erp_http_503",
        "message": "reconciliation query temporarily unavailable",
        "http_status": 503,
    }


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

    assert result["success"] is False
    assert result["error"]["code"] == "erp_transport_error"
    assert "private ERP timed out after 12 seconds" in result["error"]["message"]


def test_invalid_packing_columns_preserve_parser_error(monkeypatch, tmp_path: Path) -> None:
    _configure(monkeypatch, tmp_path)
    _write_packing(
        tmp_path / "SP260710001.xlsx",
        [{"MSKU": "MSKU-A", "错误数量列": 8}],
    )

    result = cli.run({"ship_no": "SP260710001"})

    assert result["success"] is False
    assert result["error"]["code"] == "packing_upload_failed"
    assert "装箱数量" in result["error"]["message"]
