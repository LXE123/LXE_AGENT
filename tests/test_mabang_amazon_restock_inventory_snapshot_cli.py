from __future__ import annotations

import json

from agent_runtime.skill_index import load_skill_index
from services.agent_cli.mabang import build_amazon_restock_inventory_snapshot as cli
from services.mabang.amazon.fba.amazon_restock_inventory import (
    AmazonRestockInventorySnapshotResult,
    AmazonRestockInventoryValidationSummary,
)


def _read_payload(capsys) -> dict:
    output = capsys.readouterr().out.strip().splitlines()
    assert output
    return json.loads(output[-1])


def _result(snapshot_path: str) -> AmazonRestockInventorySnapshotResult:
    return AmazonRestockInventorySnapshotResult(
        store_name="Amazon-Test-US",
        snapshot_time="202606211530",
        snapshot_date="20260621",
        snapshot_xlsx_path=snapshot_path,
        source_csv_path="restock.csv",
        source_msku_xlsx_path="msku.xlsx",
        row_count=10,
        msku_count=10,
        total_amazon_restock_inventory=100,
        validation=AmazonRestockInventoryValidationSummary(
            country="US",
            mabang_site="美国站",
            amazon_sku_count=10,
            matched_amazon_sku_count=8,
            amazon_sku_match_ratio=0.8,
            top_inventory_sku_count=10,
            top_inventory_matched_count=8,
        ),
    )


def test_missing_store_name_returns_failure_json(capsys) -> None:
    exit_code = cli.main([])

    payload = _read_payload(capsys)
    assert exit_code == 1
    assert payload == {
        "success": False,
        "store_name": "",
        "exception": "store_name 不能为空",
    }


def test_missing_csv_returns_failure_json(capsys) -> None:
    exit_code = cli.main(["--store-name", "Amazon-Test-US"])

    payload = _read_payload(capsys)
    assert exit_code == 1
    assert payload == {
        "success": False,
        "store_name": "Amazon-Test-US",
        "exception": "csv 不能为空",
    }


def test_success_returns_snapshot_payload(monkeypatch, capsys, tmp_path) -> None:
    csv_path = tmp_path / "restock.csv"
    msku_path = tmp_path / "msku.xlsx"

    def fake_build_amazon_restock_inventory_snapshot(
        csv_path_arg,
        *,
        store_name,
        output_dir=None,
        msku_xlsx_path=None,
        msku_dir=None,
    ):
        assert csv_path_arg == str(csv_path)
        assert store_name == "Amazon-Test-US"
        assert output_dir == str(tmp_path)
        assert msku_xlsx_path == str(msku_path)
        assert msku_dir is None
        return _result(str(tmp_path / "snapshot.xlsx"))

    monkeypatch.setattr(cli, "build_amazon_restock_inventory_snapshot", fake_build_amazon_restock_inventory_snapshot)

    exit_code = cli.main(
        [
            "--store-name",
            "Amazon-Test-US",
            "--csv",
            str(csv_path),
            "--output-dir",
            str(tmp_path),
            "--msku-xlsx",
            str(msku_path),
        ]
    )

    payload = _read_payload(capsys)
    assert exit_code == 0
    assert payload["snapshot_xlsx_path"] == str(tmp_path / "snapshot.xlsx")
    assert payload["amazon_restock_inventory_validation"]["top_inventory_matched_count"] == 8
    assert payload["source"] == "amazon_restock_inventory_snapshot"


def test_build_error_returns_failure_json(monkeypatch, capsys) -> None:
    def fake_build_amazon_restock_inventory_snapshot(*args, **kwargs):
        raise RuntimeError("build failed")

    monkeypatch.setattr(cli, "build_amazon_restock_inventory_snapshot", fake_build_amazon_restock_inventory_snapshot)

    exit_code = cli.main(["--store-name", "Amazon-Test-US", "--csv", "restock.csv"])

    payload = _read_payload(capsys)
    assert exit_code == 1
    assert payload == {
        "success": False,
        "store_name": "Amazon-Test-US",
        "exception": "build failed",
    }


def test_skill_index_loads_replenishment_amazon_restock_inventory_snapshot() -> None:
    index = load_skill_index(force_reload=True)
    manifest = index.get("replenishment-amazon-restock-inventory-snapshot")

    assert manifest is not None
    assert manifest.name == "replenishment-amazon-restock-inventory-snapshot"
    assert manifest.type == "amazon_replenish"
    text = manifest.body_path.read_text(encoding="utf-8")
    assert "send_file" in text
    assert "不要读取、不要解析、不要复述截图内容" in text
    assert "services.agent_cli.mabang.build_amazon_restock_inventory_snapshot" in text
    assert "skills/replenishment-amazon-restock-inventory-snapshot/assets/amazon_restock_inventory_download_step_1_menu.jpg" in text
    assert "skills/replenishment-amazon-restock-inventory-snapshot/assets/amazon_restock_inventory_download_step_2_report_menu.jpg" in text
    assert "skills/replenishment-amazon-restock-inventory-snapshot/assets/amazon_restock_inventory_download_step_3_request_csv.jpg" in text


def test_old_replenishment_amazon_fba_inventory_snapshot_skill_is_hidden() -> None:
    manifest = load_skill_index(force_reload=True).get("replenishment-amazon-fba-inventory-snapshot")

    assert manifest is None
