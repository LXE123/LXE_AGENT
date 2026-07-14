from __future__ import annotations


from services.agent_cli.mabang import export_store_msku_actual_inventory as cli
from services.mabang.amazon.fba.store_msku_actual_inventory import ActualInventoryResult


def test_missing_store_name_returns_failure_json(monkeypatch, capsys) -> None:

    payload = cli.run({})
    assert payload == {
        "success": False,
        "store_name": "",
        "exception": "store_name 不能为空",
    }


def test_success_returns_actual_inventory_path(monkeypatch, capsys) -> None:
    async def fake_export_store_msku_actual_inventory(store_name: str):
        assert store_name == "Amazon-Lerxiuer-FR"
        return ActualInventoryResult(
            store_name="Amazon-Lerxiuer-FR",
            source_msku_xlsx_path="artifacts/mabang_store_msku/202605251530-Amazon-Lerxiuer-FR_店铺MSKU数据.xlsx",
            source_msku_data_time="202605251530",
            unique_local_sku_count=120,
            detected_combo_sku_count=8,
            queried_warehouse_stock_sku_count=135,
            missing_warehouse_stock_skus=["SKU-A", "SKU-B"],
            shenzhen_warehouse_inventory_report_xlsx_path="artifacts/mabang_store_msku_inventory/202605251530-Amazon-Lerxiuer-FR_真实库存（深圳仓库）.xlsx",
            matched_warehouse_inventory_msku_row_count=118,
            missing_local_sku_msku_row_count=3,
            missing_warehouse_inventory_msku_row_count=2,
        )

    monkeypatch.setattr(cli, "export_store_msku_actual_inventory", fake_export_store_msku_actual_inventory)

    payload = cli.run({"store_name": "Amazon-Lerxiuer-FR"})
    assert payload == {
        "success": True,
        "store_name": "Amazon-Lerxiuer-FR",
        "warehouse_id": "1014318",
        "warehouse_name": "深圳仓库",
        "source_msku_xlsx_path": "artifacts/mabang_store_msku/202605251530-Amazon-Lerxiuer-FR_店铺MSKU数据.xlsx",
        "source_msku_data_time": "202605251530",
        "unique_local_sku_count": 120,
        "detected_combo_sku_count": 8,
        "queried_warehouse_stock_sku_count": 135,
        "matched_warehouse_inventory_msku_row_count": 118,
        "missing_local_sku_msku_row_count": 3,
        "missing_warehouse_inventory_msku_row_count": 2,
        "missing_warehouse_stock_sku_count": 2,
        "missing_warehouse_stock_skus": ["SKU-A", "SKU-B"],
        "shenzhen_warehouse_inventory_report_xlsx_path": "artifacts/mabang_store_msku_inventory/202605251530-Amazon-Lerxiuer-FR_真实库存（深圳仓库）.xlsx",
        "result_source": "mabang_store_msku_shenzhen_warehouse_inventory",
    }
    assert "stock_sku_count" not in payload
    assert "xlsx_path" not in payload
    assert "source" not in payload


def test_failure_returns_last_line_json(monkeypatch, capsys) -> None:
    async def fake_export_store_msku_actual_inventory(store_name: str):
        raise RuntimeError(f"inventory failed for {store_name}")

    monkeypatch.setattr(cli, "export_store_msku_actual_inventory", fake_export_store_msku_actual_inventory)

    payload = cli.run({"store_name": "Amazon-Lerxiuer-FR"})
    assert payload == {
        "success": False,
        "store_name": "Amazon-Lerxiuer-FR",
        "exception": "inventory failed for Amazon-Lerxiuer-FR",
    }
