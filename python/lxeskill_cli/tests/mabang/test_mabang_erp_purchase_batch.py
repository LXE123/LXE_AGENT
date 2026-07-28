from __future__ import annotations

from copy import deepcopy
from io import BytesIO
from pathlib import Path
from typing import Any
from urllib.parse import quote

import pytest
from openpyxl import Workbook, load_workbook

from services.agent_cli.mabang import erp_purchase_batch as erp
from services.agent_cli.mabang import fill_purchase_contracts as contract_cli
from services.agent_cli.mabang import generate_purchase_batch_workbooks as cli


def _write_delivery_csv(
    path: Path,
    *,
    msku_quantity: str = "5",
    sku_quantity: str = "10",
) -> None:
    path.write_text(
        "\n".join(
            [
                '"发货单号","MSKU","MSKU发货量","SKU发货量","国家","备注"',
                f'"SP260710001","MSKU-X","{msku_quantity}","SKU-A × {sku_quantity}","德国",""',
            ]
        ),
        encoding="utf-8-sig",
    )


def _write_master(path: Path) -> None:
    workbook = Workbook()
    sku = workbook.active
    sku.title = "SKU表"
    sku.append(["库存sku", "产品名称", "型号", "原价", "厂家", "备用厂家"])
    sku.append(["SKU-A", "产品A", "A-1", 3.5, "深圳正飞科技", ""])
    contracts = workbook.create_sheet("供应商合同信息")
    contracts.append(["供货方", "单位", "合同产品名称", "合同编号前缀", "税率"])
    contracts.append(["深圳正飞科技", "个", "合同产品A", "ZF", "13%"])
    workbook.save(path)


def _fixture_inputs(tmp_path: Path, *, msku_quantity: str = "5", sku_quantity: str = "10") -> tuple[Path, Path]:
    csv_dir = tmp_path / "csv"
    csv_dir.mkdir()
    _write_delivery_csv(
        csv_dir / "SP260710001_1.csv",
        msku_quantity=msku_quantity,
        sku_quantity=sku_quantity,
    )
    master = tmp_path / "master.xlsx"
    _write_master(master)
    return csv_dir, master


def _erp_result() -> dict[str, Any]:
    return {
        "status": "created",
        "batch_id": "00000000-0000-0000-0000-000000000001",
        "batch_no": "PB20260723-0001",
        "revision_id": "00000000-0000-0000-0000-000000000006",
        "version_no": 1,
        "sp_nos": ["SP260710001"],
        "contracts": [
            {
                "contract_id": "00000000-0000-0000-0000-000000000002",
                "supplier_name": "深圳正飞科技",
                "contract_no": "ZF20260723001",
            }
        ],
        "purchase_lines": [
            {
                "supplier_name": "深圳正飞科技",
                "tax_rate": "13%",
                "line_ref": "L0001",
                "contract_product_name": "合同产品A",
                "model": "A-1",
                "unit": "个",
                "source_tax_unit_price": 3.5,
                "planned_shipment_quantity": 10,
                "carryover_applied_quantity": 4,
                "purchase_quantity": 6,
                "contract_no": "ZF20260723001",
                "contract_id": "00000000-0000-0000-0000-000000000002",
                "tax_unit_price": 3.5,
                "inventory_sources": [
                    {
                        "carryover_entry_id": "00000000-0000-0000-0000-000000000003",
                        "source_contract_no": "ZF20260601001",
                        "historical_tax_unit_price": 3,
                        "source_reference": "SP-OLD",
                        "acquired_on": "2026-06-01",
                        "available_quantity": 4,
                        "suggested_applied_quantity": 4,
                        "version_no": 1,
                    }
                ],
                "applications": [
                    {
                        "carryover_entry_id": "00000000-0000-0000-0000-000000000003",
                        "applied_quantity": 4,
                        "source_contract_no": "ZF20260601001",
                        "historical_tax_unit_price": 3,
                        "source_reference": "SP-OLD",
                        "acquired_on": "2026-06-01",
                        "version_no": 1,
                    }
                ],
                "allocation_details": [
                    {
                        "sp_no": "SP260710001",
                        "stock_sku": "SKU-A",
                        "source_kind": "carryover",
                        "carryover_entry_id": "00000000-0000-0000-0000-000000000003",
                        "quantity": 4,
                        "source_contract_no": "ZF20260601001",
                        "historical_tax_unit_price": 3,
                    },
                    {
                        "sp_no": "SP260710001",
                        "stock_sku": "SKU-A",
                        "source_kind": "current_purchase",
                        "carryover_entry_id": None,
                        "quantity": 6,
                        "source_contract_no": "",
                        "historical_tax_unit_price": None,
                    },
                ],
            }
        ],
    }


def _request_payload() -> dict[str, Any]:
    return {
        "request_id": "purchase-1",
        "source_sha256": "a" * 64,
        "suppliers": [{"name": "深圳正飞科技", "contract_prefix": "ZF"}],
        "sps": [
            {
                "sp_no": "SP260710001",
                "planned_lines": [
                    {
                        "stock_sku": "SKU-A",
                        "product_name": "产品A",
                        "model": "A-1",
                        "supplier_name": "深圳正飞科技",
                        "planned_shipment_quantity": "10",
                    }
                ],
            }
        ],
        "contracts": [
            {
                "supplier_name": "深圳正飞科技",
                "tax_rate": "13%",
                "lines": [
                    {
                        "line_ref": "L0001",
                        "contract_product_name": "合同产品A",
                        "model": "A-1",
                        "unit": "个",
                        "source_tax_unit_price": "3.5",
                        "planned_shipment_quantity": "10",
                        "allocations": [
                            {
                                "sp_no": "SP260710001",
                                "stock_sku": "SKU-A",
                                "planned_quantity": "10",
                            }
                        ],
                    }
                ],
            }
        ],
    }


def _quote_response(*, status: str = "confirmation_required") -> dict[str, Any]:
    line = deepcopy(_erp_result()["purchase_lines"][0])
    for key in ("contract_no", "contract_id", "tax_unit_price"):
        line.pop(key)
    quote_payload = {
        "quote_id": "00000000-0000-0000-0000-000000000004",
        "intent_sha256": "b" * 64,
        "inventory_sha256": "c" * 64,
        "planned_shipment_quantity": 10,
        "carryover_applied_quantity": 4,
        "purchase_quantity": 6,
        "inventory_issues": [],
        "lines": [line],
    }
    if status == "confirmation_required":
        return {
            "status": status,
            "error": {
                "code": "purchase_inventory_confirmation_required",
                "message": "ERP inventory is available; confirmation is required",
            },
            **quote_payload,
        }
    return {
        "status": "quote_stale",
        "error": {
            "code": "purchase_inventory_quote_stale",
            "message": "inventory changed after confirmation; review the latest quote",
        },
        "latest_quote": quote_payload,
    }


def test_build_intent_uploads_exact_unit_components_without_declared_quantity(tmp_path: Path) -> None:
    csv_dir, master = _fixture_inputs(tmp_path)

    payload, context = erp.build_purchase_intent(
        ["SP260710001"], master_xlsx=master, csv_dir=csv_dir
    )

    assert context["delivery_nos"] == ["SP260710001"]
    assert payload["sps"][0]["mskus"] == [
        {
            "msku": "MSKU-X",
            "components": [{"stock_sku": "SKU-A", "quantity_per_msku": "2"}],
        }
    ]
    assert "declared_ship_quantity" not in payload["sps"][0]["mskus"][0]
    assert payload["sps"][0]["planned_lines"][0]["planned_shipment_quantity"] == "10"
    line = payload["contracts"][0]["lines"][0]
    assert line["source_tax_unit_price"] == "3.5"
    assert "purchase_quantity" not in line
    assert "carryover_applied_quantity" not in line
    assert payload["request_id"].startswith("purchase-")


def test_build_intent_rejects_non_integer_unit_component(tmp_path: Path) -> None:
    csv_dir, master = _fixture_inputs(tmp_path, msku_quantity="4", sku_quantity="10")

    with pytest.raises(erp.PurchaseBatchClientError, match="无法推导整数 quantity_per_msku"):
        erp.build_purchase_intent(["SP260710001"], master_xlsx=master, csv_dir=csv_dir)


@pytest.mark.parametrize("tax_rate", ["", "not-a-tax-rate", "NaN%"])
def test_build_intent_rejects_missing_or_invalid_tax_rate_before_http(
    tmp_path: Path,
    tax_rate: str,
) -> None:
    csv_dir, master = _fixture_inputs(tmp_path)
    workbook = load_workbook(master)
    workbook["供应商合同信息"]["E2"] = tax_rate
    workbook.save(master)
    workbook.close()

    with pytest.raises(erp.PurchaseBatchClientError) as captured:
        erp.build_purchase_intent(
            ["SP260710001"], master_xlsx=master, csv_dir=csv_dir
        )

    assert captured.value.code == "purchase_intent_invalid"
    assert "税率" in str(captured.value)


def test_confirmation_response_does_not_generate_files(monkeypatch) -> None:
    payload = _request_payload()
    response = _quote_response()
    monkeypatch.setattr(
        erp,
        "build_purchase_intent",
        lambda *args, **kwargs: (
            payload,
            {"delivery_nos": ["SP260710001"], "csv_paths": [], "master_xlsx": "master.xlsx"},
        ),
    )
    monkeypatch.setattr(erp, "import_purchase_intent", lambda _payload: (409, response))
    monkeypatch.setattr(contract_cli, "validate_contract_template", lambda *args, **kwargs: {})
    monkeypatch.setattr(
        cli,
        "generate_purchase_batch_workbooks",
        lambda *args, **kwargs: pytest.fail("confirmation must not generate files"),
    )

    result = cli.run(
        {
            "delivery_no": ["SP260710001"],
            "master_xlsx": "master.xlsx",
            "contract_template_xlsx": "contracts.xlsx",
            "gross_margin": "0.3",
        }
    )

    assert result["success"] is False
    assert result["status"] == "confirmation_required"
    assert result["error"]["code"] == "purchase_inventory_confirmation_required"
    assert result["erp"] == response


def test_stale_quote_preserves_latest_server_quote(monkeypatch) -> None:
    payload = _request_payload()
    response = _quote_response(status="quote_stale")
    monkeypatch.setattr(
        erp,
        "build_purchase_intent",
        lambda *args, **kwargs: (
            payload,
            {"delivery_nos": ["SP260710001"], "csv_paths": [], "master_xlsx": "master.xlsx"},
        ),
    )
    monkeypatch.setattr(erp, "import_purchase_intent", lambda _payload: (409, response))
    monkeypatch.setattr(contract_cli, "validate_contract_template", lambda *args, **kwargs: {})

    result = cli.run(
        {
            "delivery_no": ["SP260710001"],
            "master_xlsx": "master.xlsx",
            "contract_template_xlsx": "contracts.xlsx",
            "gross_margin": "0.3",
        }
    )

    assert result["success"] is False
    assert result["status"] == "quote_stale"
    assert result["error"]["code"] == "purchase_inventory_quote_stale"
    assert result["erp"]["latest_quote"] == response["latest_quote"]


def test_draft_never_calls_erp_and_marks_outputs(monkeypatch, tmp_path: Path) -> None:
    purchase_path = tmp_path / "purchase.xlsx"
    restock_path = tmp_path / "restock.xlsx"
    for path, sheet_name in ((purchase_path, "采购汇总"), (restock_path, "备货单")):
        workbook = Workbook()
        workbook.active.title = sheet_name
        workbook.active.append(["数量"])
        workbook.active.append([10])
        workbook.save(path)
    generated = {
        "success": True,
        "delivery_nos": ["SP260710001"],
        "purchase_summary_xlsx": str(purchase_path),
        "restock_xlsx_paths": [str(restock_path)],
        "restock_outputs": [{"delivery_no": "SP260710001", "output_xlsx": str(restock_path)}],
    }
    monkeypatch.setattr(cli, "generate_purchase_batch_workbooks", lambda *args, **kwargs: dict(generated))
    monkeypatch.setattr(
        erp,
        "import_purchase_intent",
        lambda _payload: pytest.fail("draft must not call ERP"),
    )

    result = cli.run(
        {
            "delivery_no": ["SP260710001"],
            "master_xlsx": "master.xlsx",
            "gross_margin": "0.3",
            "draft": True,
        }
    )

    assert result["success"] is True
    assert result["mode"] == "draft"
    assert result["erp_synced"] is False
    assert Path(result["purchase_summary_xlsx"]).name == "purchase-DRAFT.xlsx"
    workbook = load_workbook(result["purchase_summary_xlsx"], read_only=True)
    try:
        assert workbook.sheetnames[0] == "草稿-未同步ERP"
        sheet = workbook["采购汇总"]
        assert [cell.value for cell in sheet[1]] == [
            "计划发货量",
            "本次采购量",
            "留存库存抵扣量",
        ]
        assert [cell.value for cell in sheet[2]] == [10, 10, 0]
    finally:
        workbook.close()


def test_formal_workbooks_split_three_quantities_and_yellow_inventory_row(tmp_path: Path) -> None:
    csv_dir, master = _fixture_inputs(tmp_path)
    generated = cli.generate_purchase_batch_workbooks(
        ["SP260710001"],
        master_xlsx=master,
        gross_margin="0.3",
        csv_dir=csv_dir,
        purchase_output_dir=tmp_path / "purchase",
        restock_output_dir=tmp_path / "restock",
    )

    request_payload, _context = erp.build_purchase_intent(
        ["SP260710001"], master_xlsx=master, csv_dir=csv_dir
    )
    erp.validate_purchase_response(
        status_code=201,
        response=_erp_result(),
        request_payload=request_payload,
    )
    result = erp.apply_formal_erp_result(
        generated,
        _erp_result(),
        request_payload=request_payload,
    )

    assert result["success"] is True
    assert result["mode"] == "formal"
    summary = load_workbook(result["purchase_summary_xlsx"], data_only=True)
    try:
        sheet = summary["采购汇总"]
        headers = [cell.value for cell in sheet[1]]
        assert headers[headers.index("计划发货量") : headers.index("计划发货量") + 3] == [
            "计划发货量",
            "本次采购量",
            "留存库存抵扣量",
        ]
        assert sheet.cell(2, headers.index("计划发货量") + 1).value == 10
        assert sheet.cell(2, headers.index("本次采购量") + 1).value == 6
        assert sheet.cell(2, headers.index("留存库存抵扣量") + 1).value == 4
    finally:
        summary.close()

    restock = load_workbook(result["restock_xlsx_paths"][0], data_only=True)
    try:
        sheet = restock["备货单"]
        headers = [cell.value for cell in sheet[1]]
        order_col = headers.index("采购订单号") + 1
        planned_col = headers.index("计划发货量") + 1
        purchase_col = headers.index("本次采购量") + 1
        carryover_col = headers.index("留存库存抵扣量") + 1
        assert sheet.cell(2, order_col).value == "ZF20260723001"
        assert (sheet.cell(2, planned_col).value, sheet.cell(2, purchase_col).value, sheet.cell(2, carryover_col).value) == (6, 6, 0)
        assert sheet.cell(3, order_col).value == "ZF20260601001"
        assert (sheet.cell(3, planned_col).value, sheet.cell(3, purchase_col).value, sheet.cell(3, carryover_col).value) == (4, 0, 4)
        assert all(cell.fill.fgColor.rgb == "FFFFFF00" for cell in sheet[3])
    finally:
        restock.close()


@pytest.mark.parametrize(
    "mutate",
    [
        lambda response: response["purchase_lines"][0].pop("purchase_quantity"),
        lambda response: response["purchase_lines"][0].__setitem__("purchase_quantity", 7),
        lambda response: response["purchase_lines"][0].__setitem__(
            "allocation_details",
            response["purchase_lines"][0]["allocation_details"][:-1],
        ),
    ],
    ids=["missing-required-field", "line-invariant", "sp-sku-conservation"],
)
def test_success_response_must_be_complete_and_conserve_allocations(mutate) -> None:
    response = deepcopy(_erp_result())
    mutate(response)

    with pytest.raises(erp.PurchaseBatchClientError) as captured:
        erp.validate_purchase_response(
            status_code=201,
            response=response,
            request_payload=_request_payload(),
        )

    assert captured.value.code == "erp_purchase_result_incomplete"


def test_quote_response_must_preserve_inventory_source_lineage() -> None:
    response = _quote_response()
    response["lines"][0]["inventory_sources"][0].pop("source_contract_no")

    with pytest.raises(erp.PurchaseBatchClientError) as captured:
        erp.validate_purchase_response(
            status_code=409,
            response=response,
            request_payload=_request_payload(),
        )

    assert captured.value.code == "erp_purchase_result_incomplete"
    assert "source_contract_no" in str(captured.value)


def test_cli_marks_success_validation_failure_as_committed(monkeypatch) -> None:
    response = deepcopy(_erp_result())
    response["purchase_lines"][0].pop("purchase_quantity")
    monkeypatch.setattr(
        erp,
        "build_purchase_intent",
        lambda *args, **kwargs: (
            _request_payload(),
            {
                "delivery_nos": ["SP260710001"],
                "csv_paths": [],
                "master_xlsx": "master.xlsx",
            },
        ),
    )
    monkeypatch.setattr(erp, "import_purchase_intent", lambda _payload: (201, response))
    monkeypatch.setattr(contract_cli, "validate_contract_template", lambda *args, **kwargs: {})
    monkeypatch.setattr(
        cli,
        "generate_purchase_batch_workbooks",
        lambda *args, **kwargs: pytest.fail("invalid ERP response must not generate files"),
    )

    result = cli.run(
        {
            "delivery_no": ["SP260710001"],
            "master_xlsx": "master.xlsx",
            "contract_template_xlsx": "contracts.xlsx",
            "gross_margin": "0.3",
        }
    )

    assert result["success"] is False
    assert result["status"] == "batch_committed_artifact_generation_failed"
    assert result["error"]["code"] == "batch_committed_artifact_generation_failed"
    assert result["artifact_error"]["code"] == "erp_purchase_result_incomplete"
    assert result["batch_id"] == response["batch_id"]


def test_formal_success_renders_contracts_locally_without_erp_download(
    monkeypatch,
    tmp_path: Path,
) -> None:
    response = deepcopy(_erp_result())
    purchase_path = tmp_path / "purchase.xlsx"
    restock_path = tmp_path / "restock.xlsx"
    contract_path = tmp_path / "ZF20260723001-深圳正飞科技.xlsx"
    for path in (purchase_path, restock_path, contract_path):
        path.write_text("artifact", encoding="utf-8")
    monkeypatch.setattr(
        erp,
        "build_purchase_intent",
        lambda *args, **kwargs: (
            _request_payload(),
            {
                "delivery_nos": ["SP260710001"],
                "csv_paths": [],
                "master_xlsx": "master.xlsx",
            },
        ),
    )
    monkeypatch.setattr(contract_cli, "validate_contract_template", lambda *args, **kwargs: {})
    monkeypatch.setattr(erp, "import_purchase_intent", lambda _payload: (201, response))
    monkeypatch.setattr(
        cli,
        "generate_purchase_batch_workbooks",
        lambda *args, **kwargs: {
            "success": True,
            "purchase_summary_xlsx": str(purchase_path),
            "restock_xlsx_paths": [str(restock_path)],
            "restock_outputs": [
                {"delivery_no": "SP260710001", "output_xlsx": str(restock_path)}
            ],
        },
    )
    monkeypatch.setattr(
        erp,
        "apply_formal_erp_result",
        lambda generated, erp_result, **kwargs: {
            **generated,
            **erp_result,
            "mode": "formal",
        },
    )
    seen: list[dict] = []

    def fake_fill_formal_purchase_contracts(**kwargs):
        seen.append(kwargs)
        return {
            "success": True,
            "contract_template_xlsx": kwargs["contract_template_xlsx"],
            "output_files": [
                {
                    "manufacturer": "深圳正飞科技",
                    "sheet_name": "深圳正飞科技",
                    "contract_no": "ZF20260723001",
                    "output_xlsx": str(contract_path),
                }
            ],
        }

    monkeypatch.setattr(
        contract_cli,
        "fill_formal_purchase_contracts",
        fake_fill_formal_purchase_contracts,
    )
    monkeypatch.setattr(
        erp,
        "download_contract_workbooks",
        lambda _result: pytest.fail("formal mode must not download contracts from ERP"),
    )

    result = cli.run(
        {
            "delivery_no": ["SP260710001"],
            "master_xlsx": "master.xlsx",
            "contract_template_xlsx": "contracts.xlsx",
            "gross_margin": "0.3",
        }
    )

    assert result["success"] is True
    assert result["status"] == "completed"
    assert result["contract_xlsx_paths"] == [str(contract_path)]
    assert seen[0]["contracts"] == response["contracts"]


def test_cli_preserves_local_artifacts_when_formal_contract_generation_fails(
    monkeypatch,
    tmp_path: Path,
) -> None:
    response = deepcopy(_erp_result())
    purchase_path = tmp_path / "purchase.xlsx"
    restock_path = tmp_path / "restock.xlsx"
    completed_contract_path = tmp_path / "ZF20260723001-厂家A.xlsx"
    for path in (purchase_path, restock_path, completed_contract_path):
        path.write_text("artifact", encoding="utf-8")
    monkeypatch.setattr(
        erp,
        "build_purchase_intent",
        lambda *args, **kwargs: (
            _request_payload(),
            {
                "delivery_nos": ["SP260710001"],
                "csv_paths": [],
                "master_xlsx": "master.xlsx",
            },
        ),
    )
    monkeypatch.setattr(erp, "import_purchase_intent", lambda _payload: (201, response))
    monkeypatch.setattr(contract_cli, "validate_contract_template", lambda *args, **kwargs: {})
    monkeypatch.setattr(
        cli,
        "generate_purchase_batch_workbooks",
        lambda *args, **kwargs: {
            "success": True,
            "purchase_summary_xlsx": str(purchase_path),
            "restock_xlsx_paths": [str(restock_path)],
            "restock_outputs": [
                {"delivery_no": "SP260710001", "output_xlsx": str(restock_path)}
            ],
        },
    )
    monkeypatch.setattr(
        erp,
        "apply_formal_erp_result",
        lambda generated, erp_result, **kwargs: {
            **generated,
            **erp_result,
            "mode": "formal",
        },
    )
    monkeypatch.setattr(
        contract_cli,
        "fill_formal_purchase_contracts",
        lambda **kwargs: (_ for _ in ()).throw(
            contract_cli.FormalContractGenerationError(
                "disk full",
                output_files=[
                    {
                        "manufacturer": "厂家A",
                        "sheet_name": "厂家A",
                        "contract_no": "ZF20260723001",
                        "output_xlsx": str(completed_contract_path),
                    }
                ],
            )
        ),
    )
    monkeypatch.setattr(
        erp,
        "download_contract_workbooks",
        lambda _result: pytest.fail("formal mode must not download contracts from ERP"),
    )

    result = cli.run(
        {
            "delivery_no": ["SP260710001"],
            "master_xlsx": "master.xlsx",
            "contract_template_xlsx": "contracts.xlsx",
            "gross_margin": "0.3",
        }
    )

    assert result["status"] == "batch_committed_artifact_generation_failed"
    assert result["batch_id"] == response["batch_id"]
    assert result["purchase_summary_xlsx"] == str(purchase_path)
    assert result["restock_xlsx_paths"] == [str(restock_path)]
    assert result["contract_xlsx_paths"] == [str(completed_contract_path)]
    assert result["artifact_error"] == {
        "code": "FormalContractGenerationError",
        "message": "disk full",
    }


def test_invalid_contract_template_stops_before_erp_commit(monkeypatch, tmp_path: Path) -> None:
    invalid_template = tmp_path / "invalid-contract-template.xlsx"
    invalid_template.write_text("not an xlsx", encoding="utf-8")
    monkeypatch.setattr(
        erp,
        "build_purchase_intent",
        lambda *args, **kwargs: (
            _request_payload(),
            {
                "delivery_nos": ["SP260710001"],
                "csv_paths": [],
                "master_xlsx": "master.xlsx",
            },
        ),
    )
    monkeypatch.setattr(
        erp,
        "import_purchase_intent",
        lambda _payload: pytest.fail("invalid local template must stop before ERP commit"),
    )

    result = cli.run(
        {
            "delivery_no": ["SP260710001"],
            "master_xlsx": "master.xlsx",
            "contract_template_xlsx": str(invalid_template),
            "gross_margin": "0.3",
        }
    )

    assert result["success"] is False
    assert result["error"]["code"] == "purchase_batch_generation_failed"
    assert "不是有效 xlsx" in result["error"]["message"]


def _xlsx_bytes() -> bytes:
    workbook = Workbook()
    workbook.active["A1"] = "ERP正式合同"
    stream = BytesIO()
    workbook.save(stream)
    workbook.close()
    return stream.getvalue()


def test_contract_download_is_safe_deliverable_and_retry_restores_missing_file(
    monkeypatch,
    tmp_path: Path,
) -> None:
    from services.agent_cli.mabang import erp_http

    calls: list[str] = []
    encoded_name = quote("../../正飞合同?.xlsx", safe="")

    def fake_request_bytes(method: str, path: str, **_kwargs):
        calls.append(path)
        assert method == "GET"
        return (
            200,
            _xlsx_bytes(),
            {"Content-Disposition": f"attachment; filename*=UTF-8''{encoded_name}"},
        )

    monkeypatch.setattr(erp_http, "request_bytes", fake_request_bytes)
    source = {"contracts": deepcopy(_erp_result()["contracts"])}

    first = erp.download_contract_workbooks(dict(source), output_dir=tmp_path)
    contract_path = Path(first["contract_xlsx_paths"][0])
    assert contract_path.parent == tmp_path.resolve()
    assert contract_path.name == "正飞合同_.xlsx"
    assert first["contract_outputs"][0]["output_xlsx"] == str(contract_path)
    assert load_workbook(contract_path, read_only=True).active["A1"].value == "ERP正式合同"

    contract_path.unlink()
    second = erp.download_contract_workbooks(dict(source), output_dir=tmp_path)
    assert Path(second["contract_xlsx_paths"][0]).is_file()
    assert calls == [
        "/api/v1/erp/contracts/00000000-0000-0000-0000-000000000002/download",
        "/api/v1/erp/contracts/00000000-0000-0000-0000-000000000002/download",
    ]


def test_formal_restock_rebuilds_current_and_inventory_skus_and_product_names(
    tmp_path: Path,
) -> None:
    csv_dir = tmp_path / "csv"
    csv_dir.mkdir()
    (csv_dir / "SP260710001_1.csv").write_text(
        "\n".join(
            [
                '"发货单号","MSKU","MSKU发货量","SKU发货量","国家","备注"',
                '"SP260710001","MSKU-X","5","SKU-A × 10\nSKU-B × 5","德国",""',
            ]
        ),
        encoding="utf-8-sig",
    )
    master = tmp_path / "master.xlsx"
    _write_master(master)
    workbook = load_workbook(master)
    workbook["SKU表"].append(["SKU-B", "产品B", "A-1", 3.5, "深圳正飞科技", ""])
    workbook.save(master)
    workbook.close()

    request_payload, _context = erp.build_purchase_intent(
        ["SP260710001"], master_xlsx=master, csv_dir=csv_dir
    )
    response = deepcopy(_erp_result())
    line = response["purchase_lines"][0]
    line["planned_shipment_quantity"] = 15
    line["carryover_applied_quantity"] = 4
    line["purchase_quantity"] = 11
    line["allocation_details"] = [
        line["allocation_details"][0],
        {**line["allocation_details"][1], "quantity": 6},
        {
            **line["allocation_details"][1],
            "stock_sku": "SKU-B",
            "quantity": 5,
        },
    ]
    erp.validate_purchase_response(
        status_code=201,
        response=response,
        request_payload=request_payload,
    )
    generated = cli.generate_purchase_batch_workbooks(
        ["SP260710001"],
        master_xlsx=master,
        gross_margin="0.3",
        csv_dir=csv_dir,
        purchase_output_dir=tmp_path / "purchase",
        restock_output_dir=tmp_path / "restock",
    )
    formal = erp.apply_formal_erp_result(
        generated,
        response,
        request_payload=request_payload,
    )

    workbook = load_workbook(formal["restock_xlsx_paths"][0], data_only=True)
    try:
        sheet = workbook["备货单"]
        headers = [cell.value for cell in sheet[1]]
        sku_column = headers.index("库存sku") + 1
        product_column = headers.index("产品名称") + 1
        assert sheet.cell(2, sku_column).value == "SKU-A × 6\nSKU-B × 5"
        assert sheet.cell(2, product_column).value == "产品A\n产品B"
        assert sheet.cell(3, sku_column).value == "SKU-A × 4"
        assert sheet.cell(3, product_column).value == "产品A"
        assert all(cell.fill.fgColor.rgb == "FFFFFF00" for cell in sheet[3])
    finally:
        workbook.close()


def test_draft_rejects_confirmation_flags_without_http() -> None:
    result = cli.run(
        {
            "delivery_no": ["SP260710001"],
            "master_xlsx": "master.xlsx",
            "gross_margin": "0.3",
            "draft": True,
            "confirm_inventory_quote_id": "quote-1",
        }
    )
    assert result["success"] is False
    assert result["error"]["code"] == "draft_arguments_conflict"


def test_contract_fill_uses_actual_purchase_quantity_and_skips_zero(tmp_path: Path) -> None:
    path = tmp_path / "formal-summary.xlsx"
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "采购汇总"
    sheet.append(
        [
            "厂家",
            "合同产品名称",
            "型号",
            "单位",
            "计划发货量",
            "本次采购量",
            "留存库存抵扣量",
            "原价",
            "总价",
            "税率",
        ]
    )
    sheet.append(["厂家A", "产品A", "A-1", "个", 10, 6, 4, 3.5, 21, "13%"])
    sheet.append(["厂家A", "产品B", "A-2", "个", 5, 0, 5, 4, 0, "13%"])
    workbook.save(path)

    grouped = contract_cli.load_purchase_summary_lines(path)

    assert len(grouped["厂家A"]) == 1
    assert grouped["厂家A"][0].quantity == 6
