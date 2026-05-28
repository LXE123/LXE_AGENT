from __future__ import annotations

import json

from agent_runtime.skill_index import load_skill_index
from services.agent_cli.mabang import export_store_msku_actual_inventory as cli
from services.mabang.amazon.fba.store_msku_actual_inventory import ActualInventoryResult


def _read_payload(capsys) -> dict:
    output = capsys.readouterr().out.strip().splitlines()
    assert output
    return json.loads(output[-1])


def test_missing_store_name_returns_failure_json(monkeypatch, capsys) -> None:
    close_calls: list[str] = []

    async def fake_close_all_network_clients() -> None:
        close_calls.append("close")

    monkeypatch.setattr(cli, "close_all_network_clients", fake_close_all_network_clients)

    exit_code = cli.main([])

    payload = _read_payload(capsys)
    assert exit_code == 1
    assert payload == {
        "success": False,
        "store_name": "",
        "exception": "store_name 不能为空",
    }
    assert close_calls == ["close"]


def test_success_returns_actual_inventory_path(monkeypatch, capsys) -> None:
    close_calls: list[str] = []

    async def fake_close_all_network_clients() -> None:
        close_calls.append("close")

    async def fake_export_store_msku_actual_inventory(store_name: str):
        assert store_name == "Amazon-Lerxiuer-FR"
        return ActualInventoryResult(
            store_name="Amazon-Lerxiuer-FR",
            source_xlsx_path="artifacts/mabang_store_msku/202605251530-Amazon-Lerxiuer-FR_msku_data.xlsx",
            source_data_time="202605251530",
            local_sku_count=120,
            combo_sku_count=8,
            stock_sku_count=135,
            missing_stock_skus=["SKU-A", "SKU-B"],
            xlsx_path="artifacts/mabang_store_msku_inventory/202605251530-Amazon-Lerxiuer-FR_actual_inventory.xlsx",
            inventory_row_count=118,
            no_local_sku_count=3,
            no_inventory_row_count=2,
        )

    monkeypatch.setattr(cli, "close_all_network_clients", fake_close_all_network_clients)
    monkeypatch.setattr(cli, "export_store_msku_actual_inventory", fake_export_store_msku_actual_inventory)

    exit_code = cli.main(["--store-name", "Amazon-Lerxiuer-FR"])

    payload = _read_payload(capsys)
    assert exit_code == 0
    assert payload == {
        "success": True,
        "store_name": "Amazon-Lerxiuer-FR",
        "source_xlsx_path": "artifacts/mabang_store_msku/202605251530-Amazon-Lerxiuer-FR_msku_data.xlsx",
        "source_data_time": "202605251530",
        "local_sku_count": 120,
        "combo_sku_count": 8,
        "stock_sku_count": 135,
        "inventory_row_count": 118,
        "no_local_sku_count": 3,
        "no_inventory_row_count": 2,
        "missing_stock_sku_count": 2,
        "missing_stock_skus": ["SKU-A", "SKU-B"],
        "xlsx_path": "artifacts/mabang_store_msku_inventory/202605251530-Amazon-Lerxiuer-FR_actual_inventory.xlsx",
        "source": "mabang_store_msku_actual_inventory",
    }
    assert close_calls == ["close"]


def test_failure_returns_last_line_json(monkeypatch, capsys) -> None:
    close_calls: list[str] = []

    async def fake_close_all_network_clients() -> None:
        close_calls.append("close")

    async def fake_export_store_msku_actual_inventory(store_name: str):
        raise RuntimeError(f"inventory failed for {store_name}")

    monkeypatch.setattr(cli, "close_all_network_clients", fake_close_all_network_clients)
    monkeypatch.setattr(cli, "export_store_msku_actual_inventory", fake_export_store_msku_actual_inventory)

    exit_code = cli.main(["--store-name", "Amazon-Lerxiuer-FR"])

    payload = _read_payload(capsys)
    assert exit_code == 1
    assert payload == {
        "success": False,
        "store_name": "Amazon-Lerxiuer-FR",
        "exception": "inventory failed for Amazon-Lerxiuer-FR",
    }
    assert close_calls == ["close"]


def test_skill_index_loads_mabang_fba_store_actual_inventory() -> None:
    manifest = load_skill_index(force_reload=True).get("mabang-fba-store-actual-inventory")

    assert manifest is not None
    assert manifest.name == "mabang-fba-store-actual-inventory"
    assert manifest.type == "Amazon_replenish"
