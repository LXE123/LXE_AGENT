from __future__ import annotations

from pathlib import Path
from typing import Any

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
        "version_no": 1,
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
                "tax_unit_price": 3.5,
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


def test_confirmation_response_does_not_generate_files(monkeypatch) -> None:
    payload = {
        "request_id": "purchase-1",
        "source_sha256": "a" * 64,
        "suppliers": [],
        "sps": [],
        "contracts": [],
    }
    response = {
        "status": "confirmation_required",
        "error": {
            "code": "purchase_inventory_confirmation_required",
            "message": "ERP inventory is available; confirmation is required",
        },
        "quote_id": "00000000-0000-0000-0000-000000000004",
        "carryover_applied_quantity": 4,
        "purchase_quantity": 6,
        "lines": [],
    }
    monkeypatch.setattr(
        erp,
        "build_purchase_intent",
        lambda *args, **kwargs: (
            payload,
            {"delivery_nos": ["SP260710001"], "csv_paths": [], "master_xlsx": "master.xlsx"},
        ),
    )
    monkeypatch.setattr(erp, "import_purchase_intent", lambda _payload: (409, response))
    monkeypatch.setattr(
        cli,
        "generate_purchase_batch_workbooks",
        lambda *args, **kwargs: pytest.fail("confirmation must not generate files"),
    )

    result = cli.run(
        {
            "delivery_no": ["SP260710001"],
            "master_xlsx": "master.xlsx",
            "gross_margin": "0.3",
        }
    )

    assert result["success"] is False
    assert result["status"] == "confirmation_required"
    assert result["error"]["code"] == "purchase_inventory_confirmation_required"
    assert result["erp"] == response


def test_stale_quote_preserves_latest_server_quote(monkeypatch) -> None:
    payload = {
        "request_id": "purchase-1",
        "source_sha256": "a" * 64,
        "suppliers": [],
        "sps": [],
        "contracts": [],
    }
    response = {
        "status": "quote_stale",
        "error": {
            "code": "purchase_inventory_quote_stale",
            "message": "inventory changed after confirmation; review the latest quote",
        },
        "latest_quote": {
            "quote_id": "00000000-0000-0000-0000-000000000005",
            "lines": [
                {
                    "model": "A-1",
                    "inventory_sources": [
                        {
                            "source_contract_no": "ZF20260601001",
                            "historical_tax_unit_price": 3,
                            "available_quantity": 2,
                            "suggested_applied_quantity": 2,
                        }
                    ],
                }
            ],
        },
    }
    monkeypatch.setattr(
        erp,
        "build_purchase_intent",
        lambda *args, **kwargs: (
            payload,
            {"delivery_nos": ["SP260710001"], "csv_paths": [], "master_xlsx": "master.xlsx"},
        ),
    )
    monkeypatch.setattr(erp, "import_purchase_intent", lambda _payload: (409, response))

    result = cli.run(
        {
            "delivery_no": ["SP260710001"],
            "master_xlsx": "master.xlsx",
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

    result = erp.apply_formal_erp_result(generated, _erp_result())

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
