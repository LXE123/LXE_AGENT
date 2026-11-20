from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any

import pytest
import requests

from lxeskill import cli as lxeskill
from services.commands.mabang import erp_packing_upload as cli, shipment_quantity_validation


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



def _configure(
    monkeypatch,
    tmp_path: Path,
    *,
    api_key: str = "erp-secret",
) -> None:
    monkeypatch.setenv("LXE_DATA_SERVER_URL", "http://10.88.0.1:8000/")
    if api_key:
        monkeypatch.setenv("LXE_ERP_API_KEY", api_key)
    else:
        monkeypatch.delenv("LXE_ERP_API_KEY", raising=False)



def _use_delivery(monkeypatch, tmp_path: Path, rows: list[tuple[str, str, str]]) -> Path:
    path = _write_delivery(tmp_path / "delivery_csv", "SP260710001", rows)
    monkeypatch.setattr(cli, "resolve_delivery_csv_path", lambda sp_no: path)
    return path


def _preview_response(
    *,
    status: str = "confirmation_required",
    lines: list[dict[str, Any]] | None = None,
    submitted_sp_no: str | None = None,
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
    if submitted_sp_no is not None:
        payload["submitted_sp_no"] = submitted_sp_no
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




def _identical_preview(**summary: Any) -> FakeResponse:
    payload = dict(_preview_response().json())
    payload["reconciliation_status"] = "passed"
    payload["summary"] = {
        "planned_quantity": 30,
        "actual_quantity": 30,
        "difference_quantity": 0,
        "carryover_quantity": 0,
        "incomplete_issue_count": 0,
        **summary,
    }
    return FakeResponse(409, payload)


def test_upload_is_refused_when_actual_matches_plan_exactly(
    monkeypatch,
    tmp_path: Path,
) -> None:
    """马帮未回填装箱数据时，发货单上还是计划值，传上去只会写一份没有信息的快照。"""
    _configure(monkeypatch, tmp_path)
    _use_delivery(monkeypatch, tmp_path, [("MSKU-A", "30", "SKU-A × 30")])
    session = FakeSession([_identical_preview()])
    _mock_cloud(monkeypatch, session)

    result = cli.run({"ship_no": "SP260710001"})

    assert result["success"] is False
    assert result["error"]["code"] == "packing_identical_to_plan"
    assert "--confirm-identical" in result["error"]["message"]
    # 预览是只读的，被拒时不能已经提交
    assert len(session.calls) == 1


def test_confirm_identical_lets_a_genuinely_exact_shipment_through(
    monkeypatch,
    tmp_path: Path,
) -> None:
    """仓库确实如实发货是正当情况，必须留一条明确的出路，而不是把门焊死。"""
    _configure(monkeypatch, tmp_path)
    _use_delivery(monkeypatch, tmp_path, [("MSKU-A", "30", "SKU-A × 30")])
    session = FakeSession([_identical_preview()])
    _mock_cloud(monkeypatch, session)

    result = cli.run({"ship_no": "SP260710001", "confirm_identical": True})

    assert result["success"] is True


def test_offsetting_differences_are_not_treated_as_identical(
    monkeypatch,
    tmp_path: Path,
) -> None:
    """净差异为 0 不等于逐 SKU 一致。

    SP260808001 上真实发生过 +176/-176 完美抵消，只看 difference_quantity
    会把一批分配错乱的数据当成「与计划一致」而拒收，恰好放过真正该看的问题。
    """
    _configure(monkeypatch, tmp_path)
    _use_delivery(monkeypatch, tmp_path, [("MSKU-A", "30", "SKU-A × 30")])
    session = FakeSession([_identical_preview(carryover_quantity=176)])
    _mock_cloud(monkeypatch, session)

    result = cli.run({"ship_no": "SP260710001"})

    assert result["success"] is True


DELIVERY_HEADER = (
    '"发货单号","MSKU","MSKU发货量","SKU发货量"\n'
)


def _write_delivery(directory: Path, ship_no: str, rows: list[tuple[str, str, str]]) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{ship_no}_100001.csv"
    body = "".join(
        f'"{ship_no}","{msku}","{msku_qty}","{sku_detail}"\n'
        for msku, msku_qty, sku_detail in rows
    )
    path.write_text(DELIVERY_HEADER + body, encoding="utf-8")
    return path


def test_preview_uses_the_selected_revision_even_with_a_newer_export(monkeypatch, tmp_path, capsys):
    _configure(monkeypatch, tmp_path)
    ship_no = "SP260710001"
    export_dir = tmp_path / "exports"
    latest = _write_delivery(export_dir, ship_no, [("MSKU-A", "8", "SKU-A × 8")])
    monkeypatch.setattr(shipment_quantity_validation, "DELIVERY_CSV_DIR", export_dir)
    selected = _write_delivery(tmp_path, ship_no, [
        ("MSKU-A", "2", "SKU-A × 8"), ("MSKU-B", "0", "SKU-B × 6"),
    ]).rename(tmp_path / "核对后 发货单.csv")
    os.utime(selected, (1, 1))
    session = FakeSession([_preview_response(), _preview_response()])
    _mock_cloud(monkeypatch, session)

    monkeypatch.setenv("LXE_WORKSPACE_ROOT", str(tmp_path))
    exit_code = lxeskill.main(["fba", "erp", "packing-upload", "--ship-no", ship_no, "--delivery-csv", selected.name])
    assert exit_code == 0
    revision = json.loads(capsys.readouterr().out)["data"]
    default = cli.run({"ship_no": ship_no})

    assert revision["success"] and default["success"]
    assert revision["source_file_path"] == str(selected)
    assert revision["source_sha256"] == hashlib.sha256(selected.read_bytes()).hexdigest()
    assert default["source_file_path"] == str(latest)
    assert len(session.calls) == 2
    assert all(call["url"].endswith("/packing-snapshots/preview") for call in session.calls)
    body = session.calls[0]["json"]
    assert body["sp_no"] == ship_no
    assert body["source_file_name"] == selected.name
    assert body["source_sha256"] == revision["source_sha256"]
    assert body["lines"] == [{"msku": "MSKU-A", "actual_quantity": "2"}]
    assert session.calls[1]["json"]["lines"] == [{"msku": "MSKU-A", "actual_quantity": "8"}]


@pytest.mark.parametrize(("file_name", "expected_code", "error_text"), [
    ("找不到.csv", "delivery_csv_missing", "找不到发货单 CSV"),
    ("装箱.xlsx", "delivery_csv_invalid", "需要是 CSV 文件"),
    ("错误表头.csv", "delivery_csv_invalid", "发货单 CSV 缺少列"),
    ("混合发货单.csv", "delivery_csv_invalid", "第3行发货单号 SP260710099 与指定的 SP260710001 不一致"),
    ("", "delivery_csv_invalid", "--delivery-csv 需要发货单 CSV 路径"),
])
def test_invalid_selection_does_not_fall_back_or_call_erp(
    monkeypatch, tmp_path, file_name, expected_code, error_text,
):
    _configure(monkeypatch, tmp_path)
    _write_delivery(tmp_path, "SP260710001", [("MSKU-A", "8", "SKU-A × 8")])
    monkeypatch.setattr(shipment_quantity_validation, "DELIVERY_CSV_DIR", tmp_path)
    (tmp_path / "错误表头.csv").write_text("MSKU,装箱数量\nMSKU-A,9\n", encoding="utf-8")
    (tmp_path / "混合发货单.csv").write_text(
        DELIVERY_HEADER + "SP260710001,MSKU-A,2,SKU-A × 2\nSP260710099,MSKU-B,3,SKU-B × 3\n",
        encoding="utf-8",
    )
    session = FakeSession()
    _mock_cloud(monkeypatch, session)

    result = cli.run({"ship_no": "SP260710001", "delivery_csv": str(tmp_path / file_name) if file_name else ""})

    assert result["success"] is False
    assert result["error"]["code"] == expected_code
    assert error_text in result["error"]["message"]
    assert "recovery" not in result
    assert not session.calls


def test_revised_csv_without_sku_ship_qty_column_and_with_blank_row_succeeds(monkeypatch, tmp_path):
    _configure(monkeypatch, tmp_path)
    revised = tmp_path / "精简修订版.csv"
    revised.write_text(
        "MSKU,MSKU发货量\nMSKU-A,5\nMSKU-ZERO,0\n,\n",
        encoding="utf-8",
    )
    session = FakeSession([_preview_response()])
    _mock_cloud(monkeypatch, session)

    result = cli.run({"ship_no": "SP260710001", "delivery_csv": str(revised)})

    assert result["success"] is True
    assert session.calls[0]["json"]["lines"] == [{"msku": "MSKU-A", "actual_quantity": "5"}]


@pytest.mark.parametrize("bad_quantity", ["3个", "-2", ""])
def test_duplicate_msku_invalid_quantity_fails_with_row_number(monkeypatch, tmp_path, bad_quantity):
    _configure(monkeypatch, tmp_path)
    revised = tmp_path / "异常数量.csv"
    revised.write_text(
        f"MSKU,MSKU发货量\nMSKU-A,5\nMSKU-A,{bad_quantity}\n",
        encoding="utf-8",
    )
    session = FakeSession()
    _mock_cloud(monkeypatch, session)

    result = cli.run({"ship_no": "SP260710001", "delivery_csv": str(revised)})

    assert result["success"] is False
    assert result["error"]["code"] == "delivery_csv_invalid"
    assert "第3行" in result["error"]["message"]
    assert not session.calls


def test_default_local_csv_rejects_mismatched_ship_no_row(monkeypatch, tmp_path):
    _configure(monkeypatch, tmp_path)
    local_csv = tmp_path / "SP260710001_100001.csv"
    local_csv.write_text(
        DELIVERY_HEADER + "SP260710099,MSKU-A,2,SKU-A × 2\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(shipment_quantity_validation, "DELIVERY_CSV_DIR", tmp_path)
    session = FakeSession()
    _mock_cloud(monkeypatch, session)

    result = cli.run({"ship_no": "SP260710001"})

    assert result["success"] is False
    assert result["error"]["code"] == "delivery_csv_invalid"
    assert "SP260710099" in result["error"]["message"]
    assert not session.calls


def test_missing_default_local_csv_points_recovery_to_mabang_delivery_data(monkeypatch, tmp_path):
    _configure(monkeypatch, tmp_path)
    monkeypatch.setattr(shipment_quantity_validation, "DELIVERY_CSV_DIR", tmp_path)
    session = FakeSession()
    _mock_cloud(monkeypatch, session)

    result = cli.run({"ship_no": "SP260710001"})

    assert result["success"] is False
    assert result["error"]["code"] == "delivery_csv_missing"
    assert result["recovery"]["skill"] == "mabang-delivery-data"
    assert result["recovery"]["command"] == "lxeskill mabang delivery export --delivery-no SP260710001"
    assert not session.calls


def test_confirmation_with_a_new_file_requires_a_new_preview(monkeypatch, tmp_path):
    _configure(monkeypatch, tmp_path)
    session = FakeSession()
    _mock_cloud(monkeypatch, session)

    result = cli.run({"confirm_packing_quote_id": "existing-quote", "delivery_csv": "修订版.csv"})

    assert result["error"]["code"] == "packing_input_conflict"
    assert not session.calls


def test_delivery_source_sends_the_same_shape_as_the_wms_source(
    monkeypatch,
    tmp_path: Path,
) -> None:
    """换源只换数字的来源，请求体形状必须一模一样。

    ERP 用存的配比展开 MSKU发货量，结果和发货单的 SKU发货量逐 SKU 相等，
    所以接口、请求体和下游都不需要跟着改。
    """
    _configure(monkeypatch, tmp_path)
    delivery_dir = tmp_path / "delivery_csv"
    _write_delivery(
        delivery_dir,
        "SP260710001",
        [("MSKU-A", "8", "SKU-A × 8"), ("MSKU-B", "2", "SKU-B × 4")],
    )
    monkeypatch.setattr(
        cli, "resolve_delivery_csv_path", lambda sp_no: _write_delivery(
            delivery_dir,
            "SP260710001",
            [("MSKU-A", "8", "SKU-A × 8"), ("MSKU-B", "2", "SKU-B × 4")],
        )
    )
    session = FakeSession([_preview_response()])
    _mock_cloud(monkeypatch, session)

    result = cli.run({"ship_no": "SP260710001"})

    assert result["success"] is True
    body = session.calls[0]["json"]
    assert body["sp_no"] == "SP260710001"
    assert body["lines"] == [
        {"msku": "MSKU-A", "actual_quantity": "8"},
        {"msku": "MSKU-B", "actual_quantity": "2"},
    ]


def test_mapped_packing_sp_is_exposed_without_changing_canonical_ship_identity(
    monkeypatch,
    tmp_path: Path,
) -> None:
    _configure(monkeypatch, tmp_path)
    packing_sp_no = "SP260710099"
    path = _write_delivery(
        tmp_path / "delivery_csv",
        packing_sp_no,
        [("MSKU-A", "8", "SKU-A × 8")],
    )
    monkeypatch.setattr(cli, "resolve_delivery_csv_path", lambda sp_no: path)
    session = FakeSession([_preview_response(submitted_sp_no=packing_sp_no)])
    _mock_cloud(monkeypatch, session)

    result = cli.run({"ship_no": packing_sp_no})

    assert result["success"] is True
    assert session.calls[0]["json"]["sp_no"] == packing_sp_no
    assert result["ship_no"] == "SP260710001"
    assert result["purchase_sp_no"] == "SP260710001"
    assert result["packing_sp_no"] == packing_sp_no


def test_unmapped_packing_result_does_not_repeat_purchase_sp_as_alias(
    monkeypatch,
    tmp_path: Path,
) -> None:
    _configure(monkeypatch, tmp_path)
    _use_delivery(monkeypatch, tmp_path, [("MSKU-A", "8", "SKU-A × 8")])
    session = FakeSession([_preview_response(submitted_sp_no="SP260710001")])
    _mock_cloud(monkeypatch, session)

    result = cli.run({"ship_no": "SP260710001"})

    assert result["purchase_sp_no"] == "SP260710001"
    assert result["packing_sp_no"] is None


def test_purchase_sp_rejection_preserves_required_packing_sp_detail(
    monkeypatch,
    tmp_path: Path,
) -> None:
    _configure(monkeypatch, tmp_path)
    _use_delivery(monkeypatch, tmp_path, [("MSKU-A", "8", "SKU-A × 8")])
    session = FakeSession(
        [
            FakeResponse(
                409,
                {
                    "detail": {
                        "code": "packing_sp_alias_required",
                        "message": "this purchase SP has a dedicated packing SP",
                        "sp_no": "SP260710001",
                        "required_packing_sp_no": "SP260710099",
                    }
                },
            )
        ]
    )
    _mock_cloud(monkeypatch, session)

    result = cli.run({"ship_no": "SP260710001"})

    assert result["success"] is False
    assert result["error"]["code"] == "packing_sp_alias_required"
    assert result["error"]["detail"]["required_packing_sp_no"] == "SP260710099"


def test_delivery_source_skips_mskus_that_were_not_shipped(
    monkeypatch,
    tmp_path: Path,
) -> None:
    """发货量为 0 表示这个 MSKU 最终没发，不能当成装箱条目传给 ERP。"""
    _configure(monkeypatch, tmp_path)
    delivery_dir = tmp_path / "delivery_csv"
    path = _write_delivery(
        delivery_dir,
        "SP260710001",
        [("MSKU-A", "8", "SKU-A × 8"), ("MSKU-ZERO", "0", "SKU-Z × 0")],
    )
    monkeypatch.setattr(cli, "resolve_delivery_csv_path", lambda sp_no: path)
    session = FakeSession([_preview_response()])
    _mock_cloud(monkeypatch, session)

    result = cli.run({"ship_no": "SP260710001"})

    assert result["success"] is True
    assert [line["msku"] for line in session.calls[0]["json"]["lines"]] == ["MSKU-A"]






def test_request_id_is_deterministic_for_same_source(monkeypatch, tmp_path: Path) -> None:
    _configure(monkeypatch, tmp_path)
    _use_delivery(monkeypatch, tmp_path, [("MSKU-A", "8", "SKU-A × 8")])
    session = FakeSession([_preview_response(), _preview_response()])
    _mock_cloud(monkeypatch, session)

    first = cli.run({"ship_no": "SP260710001"})
    second = cli.run({"ship_no": "SP260710001"})

    assert first["request_id"] == second["request_id"]
    assert session.calls[0]["json"]["request_id"] == session.calls[1]["json"]["request_id"]


def test_confirmation_only_sends_quote_id(monkeypatch, tmp_path: Path) -> None:
    _configure(monkeypatch, tmp_path)
    session = FakeSession(
        [_created_response(), FakeResponse(200, {"lines": []})]
    )
    _mock_cloud(monkeypatch, session)
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
    _mock_cloud(monkeypatch, session)

    result = cli.run(
        {"confirm_packing_quote_id": "00000000-0000-0000-0000-000000000009"}
    )

    assert result["success"] is True
    assert result["status"] == "quote_stale"
    assert result["confirmation_required"] is True
    assert result["quote_id"] == "00000000-0000-0000-0000-000000000010"



def test_missing_erp_credentials_does_not_block_request(monkeypatch, tmp_path: Path) -> None:
    _configure(monkeypatch, tmp_path, api_key="")
    _use_delivery(monkeypatch, tmp_path, [("M1", "2", "S1 × 2")])
    session = FakeSession([_preview_response()])
    _mock_cloud(monkeypatch, session)
    result = cli.run({"source": "delivery", "ship_no": "SP260710001"})
    assert len(session.calls) == 1
    assert result.get("error", {}).get("code") != "erp_credentials_not_configured"


def test_transport_error_keeps_real_exception(monkeypatch, tmp_path: Path) -> None:
    _configure(monkeypatch, tmp_path)
    _use_delivery(monkeypatch, tmp_path, [("MSKU-A", "8", "SKU-A × 8")])
    session = FakeSession()
    session.error = requests.Timeout("private ERP timed out after 12 seconds")
    _mock_cloud(monkeypatch, session)

    result = cli.run({"ship_no": "SP260710001"})

    assert result["error"]["code"] == "erp_transport_error"
    assert "private ERP timed out after 12 seconds" in result["error"]["message"]


def _mock_cloud(monkeypatch, session):
    from shared.infra.cloud_client import CloudConnectionError
    class Client:
        def __init__(self, base, *, timeout, max_response_bytes):
            self.base, self.timeout = base, timeout
            assert max_response_bytes is None
        def call(self, method, path, **kwargs):
            try:
                return session.request(method, self.base + path, timeout=self.timeout, **kwargs)
            except Exception as exc:
                raise CloudConnectionError(exc, 0) from exc
        def request_json(self, method, path, *, json_body=None):
            return self.call(method, path, json=json_body)
        def request_bytes(self, method, path):
            return self.call(method, path)
    monkeypatch.setattr(cli, 'CloudClient', Client)
