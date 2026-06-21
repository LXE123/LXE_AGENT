from __future__ import annotations

import json

from agent_runtime.skill_index import load_skill_index
from services.agent_cli.mabang import calculate_store_msku_replenishment as cli
from services.mabang.amazon.fba.store_msku_replenishment import StoreMskuReplenishmentResult


def _read_payload(capsys) -> dict:
    output = capsys.readouterr().out.strip().splitlines()
    assert output
    return json.loads(output[-1])


def test_missing_store_name_returns_failure_json(capsys) -> None:
    exit_code = cli.main([])

    payload = _read_payload(capsys)
    assert exit_code == 1
    assert payload == {
        "success": False,
        "store_name": "",
        "exception": "store_name 不能为空",
    }


def test_success_returns_replenishment_report_path(monkeypatch, capsys) -> None:
    def fake_calculate_store_msku_replenishment(
        store_name: str,
        *,
        template_name: str | None = None,
        unlinked_shipments_snapshot_path=None,
        amazon_restock_inventory_snapshot_path=None,
        amazon_fba_inventory_snapshot_path=None,
    ):
        assert store_name == "Amazon-Lerxiuer-FR"
        assert template_name is None
        assert unlinked_shipments_snapshot_path is None
        assert amazon_restock_inventory_snapshot_path is None
        assert amazon_fba_inventory_snapshot_path is None
        return StoreMskuReplenishmentResult(
            store_name="Amazon-Lerxiuer-FR",
            source_data_time="202605251530",
            sales_analysis_xlsx_path="artifacts/mabang_store_msku_analysis/202605251530-Amazon-Lerxiuer-FR_销量分析.xlsx",
            actual_inventory_xlsx_path="artifacts/mabang_store_msku_inventory/202605251530-Amazon-Lerxiuer-FR_真实库存.xlsx",
            template_name="默认",
            template_version=1,
            row_count=120,
            link_count=18,
            air_urgent_count=10,
            air_count=18,
            sea_count=35,
            clearance_count=0,
            no_ship_count=42,
            sample_insufficient_count=15,
            report_xlsx_path="artifacts/mabang_store_msku_replenishment/202605251530-Amazon-Lerxiuer-FR_备货建议.xlsx",
        )

    monkeypatch.setattr(cli, "calculate_store_msku_replenishment", fake_calculate_store_msku_replenishment)

    exit_code = cli.main(["--store-name", "Amazon-Lerxiuer-FR"])

    payload = _read_payload(capsys)
    assert exit_code == 0
    assert payload == {
        "success": True,
        "store_name": "Amazon-Lerxiuer-FR",
        "source_data_time": "202605251530",
        "sales_analysis_xlsx_path": "artifacts/mabang_store_msku_analysis/202605251530-Amazon-Lerxiuer-FR_销量分析.xlsx",
        "actual_inventory_xlsx_path": "artifacts/mabang_store_msku_inventory/202605251530-Amazon-Lerxiuer-FR_真实库存.xlsx",
        "template_name": "默认",
        "template_version": 1,
        "row_count": 120,
        "link_count": 18,
        "air_urgent_count": 10,
        "air_count": 18,
        "sea_count": 35,
        "clearance_count": 0,
        "no_ship_count": 42,
        "sample_insufficient_count": 15,
        "report_xlsx_path": "artifacts/mabang_store_msku_replenishment/202605251530-Amazon-Lerxiuer-FR_备货建议.xlsx",
        "source": "mabang_store_msku_replenishment",
    }


def test_template_argument_passes_to_service(monkeypatch, capsys) -> None:
    def fake_calculate_store_msku_replenishment(
        store_name: str,
        *,
        template_name: str | None = None,
        unlinked_shipments_snapshot_path=None,
        amazon_restock_inventory_snapshot_path=None,
        amazon_fba_inventory_snapshot_path=None,
    ):
        assert store_name == "Amazon-Lerxiuer-FR"
        assert template_name == "老王大件方案"
        assert unlinked_shipments_snapshot_path is None
        assert amazon_restock_inventory_snapshot_path is None
        assert amazon_fba_inventory_snapshot_path is None
        return StoreMskuReplenishmentResult(
            store_name="Amazon-Lerxiuer-FR",
            source_data_time="202605251530",
            sales_analysis_xlsx_path="sales.xlsx",
            actual_inventory_xlsx_path="inventory.xlsx",
            template_name="老王大件方案",
            template_version=2,
            row_count=1,
            link_count=1,
            air_urgent_count=0,
            air_count=0,
            sea_count=1,
            clearance_count=0,
            no_ship_count=0,
            sample_insufficient_count=0,
            report_xlsx_path="report.xlsx",
        )

    monkeypatch.setattr(cli, "calculate_store_msku_replenishment", fake_calculate_store_msku_replenishment)

    exit_code = cli.main(["--store-name", "Amazon-Lerxiuer-FR", "--template", "老王大件方案"])

    payload = _read_payload(capsys)
    assert exit_code == 0
    assert payload["template_name"] == "老王大件方案"
    assert payload["template_version"] == 2


def test_unlinked_shipments_snapshot_warning_is_returned(monkeypatch, capsys) -> None:
    def fake_calculate_store_msku_replenishment(
        store_name: str,
        *,
        template_name: str | None = None,
        unlinked_shipments_snapshot_path=None,
        amazon_restock_inventory_snapshot_path=None,
        amazon_fba_inventory_snapshot_path=None,
    ):
        assert store_name == "Amazon-Lerxiuer-FR"
        assert template_name is None
        assert unlinked_shipments_snapshot_path is None
        assert amazon_restock_inventory_snapshot_path is None
        assert amazon_fba_inventory_snapshot_path is None
        return StoreMskuReplenishmentResult(
            store_name="Amazon-Lerxiuer-FR",
            source_data_time="202605251530",
            sales_analysis_xlsx_path="sales.xlsx",
            actual_inventory_xlsx_path="inventory.xlsx",
            template_name="默认",
            template_version=1,
            row_count=1,
            link_count=1,
            air_urgent_count=0,
            air_count=1,
            sea_count=0,
            clearance_count=0,
            no_ship_count=0,
            sample_insufficient_count=0,
            report_xlsx_path="report.xlsx",
            unlinked_shipments_snapshot_warning="未找到与备货数据同日的未关联货件快照，本次未扣减未关联货件",
        )

    monkeypatch.setattr(cli, "calculate_store_msku_replenishment", fake_calculate_store_msku_replenishment)

    exit_code = cli.main(["--store-name", "Amazon-Lerxiuer-FR"])

    payload = _read_payload(capsys)
    assert exit_code == 0
    assert payload["unlinked_shipments_snapshot_warning"] == "未找到与备货数据同日的未关联货件快照，本次未扣减未关联货件"


def test_unlinked_shipments_snapshot_argument_passes_to_service(monkeypatch, capsys) -> None:
    def fake_calculate_store_msku_replenishment(
        store_name: str,
        *,
        template_name: str | None = None,
        unlinked_shipments_snapshot_path=None,
        amazon_restock_inventory_snapshot_path=None,
        amazon_fba_inventory_snapshot_path=None,
    ):
        assert store_name == "Amazon-Lerxiuer-FR"
        assert template_name is None
        assert unlinked_shipments_snapshot_path == "snapshot.xlsx"
        assert amazon_restock_inventory_snapshot_path is None
        assert amazon_fba_inventory_snapshot_path is None
        return StoreMskuReplenishmentResult(
            store_name="Amazon-Lerxiuer-FR",
            source_data_time="202605251530",
            sales_analysis_xlsx_path="sales.xlsx",
            actual_inventory_xlsx_path="inventory.xlsx",
            template_name="默认",
            template_version=1,
            row_count=1,
            link_count=1,
            air_urgent_count=0,
            air_count=1,
            sea_count=0,
            clearance_count=0,
            no_ship_count=0,
            sample_insufficient_count=0,
            report_xlsx_path="report.xlsx",
            unlinked_shipments_snapshot_path="snapshot.xlsx",
        )

    monkeypatch.setattr(cli, "calculate_store_msku_replenishment", fake_calculate_store_msku_replenishment)

    exit_code = cli.main(["--store-name", "Amazon-Lerxiuer-FR", "--unlinked-shipments-snapshot", "snapshot.xlsx"])

    payload = _read_payload(capsys)
    assert exit_code == 0
    assert payload["unlinked_shipments_snapshot_path"] == "snapshot.xlsx"


def test_amazon_restock_inventory_snapshot_argument_passes_to_service(monkeypatch, capsys) -> None:
    def fake_calculate_store_msku_replenishment(
        store_name: str,
        *,
        template_name: str | None = None,
        unlinked_shipments_snapshot_path=None,
        amazon_restock_inventory_snapshot_path=None,
        amazon_fba_inventory_snapshot_path=None,
    ):
        assert store_name == "Amazon-Lerxiuer-FR"
        assert template_name is None
        assert unlinked_shipments_snapshot_path is None
        assert amazon_restock_inventory_snapshot_path == "restock_snapshot.xlsx"
        assert amazon_fba_inventory_snapshot_path is None
        return StoreMskuReplenishmentResult(
            store_name="Amazon-Lerxiuer-FR",
            source_data_time="202605251530",
            sales_analysis_xlsx_path="sales.xlsx",
            actual_inventory_xlsx_path="inventory.xlsx",
            template_name="默认",
            template_version=1,
            row_count=1,
            link_count=1,
            air_urgent_count=0,
            air_count=1,
            sea_count=0,
            clearance_count=0,
            no_ship_count=0,
            sample_insufficient_count=0,
            report_xlsx_path="report.xlsx",
            amazon_restock_inventory_snapshot_path="restock_snapshot.xlsx",
            amazon_restock_inventory_validation={
                "country": "US",
                "mabang_site": "美国站",
                "amazon_sku_count": 10,
                "matched_amazon_sku_count": 8,
                "amazon_sku_match_ratio": 0.8,
                "top_inventory_sku_count": 10,
                "top_inventory_matched_count": 8,
            },
        )

    monkeypatch.setattr(cli, "calculate_store_msku_replenishment", fake_calculate_store_msku_replenishment)

    exit_code = cli.main(["--store-name", "Amazon-Lerxiuer-FR", "--amazon-restock-inventory-snapshot", "restock_snapshot.xlsx"])

    payload = _read_payload(capsys)
    assert exit_code == 0
    assert payload["amazon_restock_inventory_snapshot_path"] == "restock_snapshot.xlsx"
    assert payload["amazon_restock_inventory_validation"]["country"] == "US"


def test_amazon_fba_inventory_snapshot_argument_passes_to_service(monkeypatch, capsys) -> None:
    def fake_calculate_store_msku_replenishment(
        store_name: str,
        *,
        template_name: str | None = None,
        unlinked_shipments_snapshot_path=None,
        amazon_restock_inventory_snapshot_path=None,
        amazon_fba_inventory_snapshot_path=None,
    ):
        assert store_name == "Amazon-Lerxiuer-FR"
        assert template_name is None
        assert unlinked_shipments_snapshot_path is None
        assert amazon_restock_inventory_snapshot_path is None
        assert amazon_fba_inventory_snapshot_path == "amazon_snapshot.xlsx"
        return StoreMskuReplenishmentResult(
            store_name="Amazon-Lerxiuer-FR",
            source_data_time="202605251530",
            sales_analysis_xlsx_path="sales.xlsx",
            actual_inventory_xlsx_path="inventory.xlsx",
            template_name="默认",
            template_version=1,
            row_count=1,
            link_count=1,
            air_urgent_count=0,
            air_count=1,
            sea_count=0,
            clearance_count=0,
            no_ship_count=0,
            sample_insufficient_count=0,
            report_xlsx_path="report.xlsx",
            amazon_fba_inventory_snapshot_path="amazon_snapshot.xlsx",
            amazon_fba_inventory_validation={
                "marketplace": "US",
                "mabang_site": "美国站",
                "amazon_sku_count": 10,
                "matched_amazon_sku_count": 8,
                "amazon_sku_match_ratio": 0.8,
                "top_inventory_sku_count": 10,
                "top_inventory_matched_count": 8,
            },
        )

    monkeypatch.setattr(cli, "calculate_store_msku_replenishment", fake_calculate_store_msku_replenishment)

    exit_code = cli.main(["--store-name", "Amazon-Lerxiuer-FR", "--amazon-fba-inventory-snapshot", "amazon_snapshot.xlsx"])

    payload = _read_payload(capsys)
    assert exit_code == 0
    assert payload["amazon_fba_inventory_snapshot_path"] == "amazon_snapshot.xlsx"
    assert payload["amazon_fba_inventory_validation"]["marketplace"] == "US"


def test_failure_returns_last_line_json(monkeypatch, capsys) -> None:
    def fake_calculate_store_msku_replenishment(
        store_name: str,
        *,
        template_name: str | None = None,
        unlinked_shipments_snapshot_path=None,
        amazon_restock_inventory_snapshot_path=None,
        amazon_fba_inventory_snapshot_path=None,
    ):
        raise RuntimeError(f"replenishment failed for {store_name}")

    monkeypatch.setattr(cli, "calculate_store_msku_replenishment", fake_calculate_store_msku_replenishment)

    exit_code = cli.main(["--store-name", "Amazon-Lerxiuer-FR"])

    payload = _read_payload(capsys)
    assert exit_code == 1
    assert payload == {
        "success": False,
        "store_name": "Amazon-Lerxiuer-FR",
        "exception": "replenishment failed for Amazon-Lerxiuer-FR",
    }


def test_skill_index_loads_mabang_fba_store_replenishment_calculate() -> None:
    manifest = load_skill_index(force_reload=True).get("replenishment-calculate")

    assert manifest is not None
    assert manifest.name == "replenishment-calculate"
    assert manifest.type == "amazon_replenish"
