from __future__ import annotations

import csv
from pathlib import Path

import pytest

from services.mabang.amazon.fba import amazon_inventory as inv


def _write_csv(path: Path, rows: list[dict]) -> Path:
    headers = [
        "snapshot-date",
        "sku",
        "marketplace",
        "Inventory Supply at FBA",
        "available",
        "inbound-quantity",
        "Total Reserved Quantity",
        "unfulfillable-quantity",
        "estimated-excess-quantity",
        "recommended-action",
        "asin",
        "product-name",
    ]
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=headers)
        writer.writeheader()
        for row in rows:
            writer.writerow(row)
    return path


def _amazon_row(sku: str, supply: int, *, marketplace: str = "US") -> dict:
    return {
        "snapshot-date": "2026-06-16",
        "sku": sku,
        "marketplace": marketplace,
        "Inventory Supply at FBA": supply,
        "available": supply,
        "inbound-quantity": 0,
        "Total Reserved Quantity": 0,
        "unfulfillable-quantity": 0,
        "estimated-excess-quantity": 0,
        "recommended-action": "NoExcessInventory",
        "asin": f"ASIN-{sku}",
        "product-name": f"Product {sku}",
    }


def _write_mabang_msku(path: Path, mskus: list[str], *, site: str = "美国站", include_site: bool = True) -> Path:
    from openpyxl import Workbook

    path.parent.mkdir(parents=True, exist_ok=True)
    workbook = Workbook()
    try:
        worksheet = workbook.active
        worksheet.title = "mskulist"
        headers = ["店铺名称", "MSKU"]
        if include_site:
            headers.insert(1, "站点")
        worksheet.append(headers)
        for msku in mskus:
            row = {"店铺名称": "Amazon-Test-US", "站点": site, "MSKU": msku}
            worksheet.append([row.get(header, "") for header in headers])
        workbook.save(path)
    finally:
        workbook.close()
    return path


def test_build_amazon_inventory_snapshot_validates_and_writes_snapshot(tmp_path) -> None:
    csv_path = _write_csv(
        tmp_path / "amazon.csv",
        [_amazon_row(f"MSKU-{index}", 100 - index) for index in range(1, 11)],
    )
    msku_path = _write_mabang_msku(tmp_path / "msku.xlsx", [f"MSKU-{index}" for index in range(1, 9)])

    result = inv.build_amazon_inventory_snapshot(
        csv_path,
        store_name="Amazon-Test-US",
        output_dir=tmp_path,
        msku_xlsx_path=msku_path,
        snapshot_time="202606161530",
    )

    payload = result.to_payload()
    assert payload["snapshot_xlsx_path"] == str(tmp_path / "202606161530-Amazon-Test-US_亚马逊后台库存快照.xlsx")
    assert payload["snapshot_date"] == "20260616"
    assert payload["msku_count"] == 10
    assert payload["total_amazon_fba_inventory"] == 945
    assert payload["amazon_inventory_validation"] == {
        "marketplace": "US",
        "mabang_site": "美国站",
        "amazon_sku_count": 10,
        "matched_amazon_sku_count": 8,
        "amazon_sku_match_ratio": 0.8,
        "top_inventory_sku_count": 10,
        "top_inventory_matched_count": 8,
    }

    snapshot = inv.load_amazon_inventory_snapshot(result.snapshot_xlsx_path, store_name="Amazon-Test-US")
    assert snapshot.snapshot_date == "20260616"
    assert snapshot.quantities_by_msku["MSKU-1"] == 99
    assert snapshot.validation is not None
    assert snapshot.validation.top_inventory_matched_count == 8


def test_marketplace_mismatch_passes_when_msku_match_is_strong(tmp_path) -> None:
    csv_path = _write_csv(tmp_path / "amazon.csv", [_amazon_row(f"MSKU-{index}", 10, marketplace="UK") for index in range(1, 11)])
    msku_path = _write_mabang_msku(tmp_path / "msku.xlsx", [f"MSKU-{index}" for index in range(1, 11)])

    result = inv.build_amazon_inventory_snapshot(
        csv_path,
        store_name="Amazon-Test-US",
        output_dir=tmp_path,
        msku_xlsx_path=msku_path,
    )

    assert result.validation.marketplace == "UK"
    assert result.validation.amazon_sku_match_ratio == 1
    assert Path(result.snapshot_xlsx_path).is_file()


def test_europe_mabang_site_passes_with_specific_amazon_marketplace(tmp_path) -> None:
    csv_path = _write_csv(tmp_path / "amazon.csv", [_amazon_row(f"MSKU-{index}", 10, marketplace="DE") for index in range(1, 11)])
    msku_path = _write_mabang_msku(tmp_path / "msku.xlsx", [f"MSKU-{index}" for index in range(1, 11)], site="欧洲站")

    result = inv.build_amazon_inventory_snapshot(
        csv_path,
        store_name="Amazon-Test-DE",
        output_dir=tmp_path,
        msku_xlsx_path=msku_path,
    )

    assert result.validation.marketplace == "DE"
    assert result.validation.mabang_site == "欧洲站"
    assert result.validation.top_inventory_matched_count == 10


def test_mabang_msku_site_column_is_optional(tmp_path) -> None:
    csv_path = _write_csv(tmp_path / "amazon.csv", [_amazon_row(f"MSKU-{index}", 10, marketplace="DE") for index in range(1, 11)])
    msku_path = _write_mabang_msku(
        tmp_path / "msku.xlsx",
        [f"MSKU-{index}" for index in range(1, 11)],
        include_site=False,
    )

    result = inv.build_amazon_inventory_snapshot(
        csv_path,
        store_name="Amazon-Test-DE",
        output_dir=tmp_path,
        msku_xlsx_path=msku_path,
    )

    assert result.validation.mabang_site == ""
    assert result.validation.amazon_sku_match_ratio == 1


def test_low_amazon_sku_match_ratio_fails(tmp_path) -> None:
    csv_path = _write_csv(
        tmp_path / "amazon.csv",
        [_amazon_row(f"MSKU-{index}", 100 - index) for index in range(1, 11)],
    )
    msku_path = _write_mabang_msku(tmp_path / "msku.xlsx", [f"MSKU-{index}" for index in range(1, 7)])

    with pytest.raises(inv.AmazonInventorySnapshotError, match="sku_match_ratio=0.6000"):
        inv.build_amazon_inventory_snapshot(
            csv_path,
            store_name="Amazon-Test-US",
            output_dir=tmp_path,
            msku_xlsx_path=msku_path,
        )


def test_low_top_inventory_sku_match_count_fails(tmp_path) -> None:
    high_rows = [_amazon_row(f"HIGH-{index}", 1000 - index) for index in range(1, 11)]
    low_rows = [_amazon_row(f"LOW-{index}", 100 - index) for index in range(1, 11)]
    csv_path = _write_csv(tmp_path / "amazon.csv", [*high_rows, *low_rows])
    matched_mskus = [f"HIGH-{index}" for index in range(1, 7)] + [f"LOW-{index}" for index in range(1, 9)]
    msku_path = _write_mabang_msku(tmp_path / "msku.xlsx", matched_mskus)

    with pytest.raises(inv.AmazonInventorySnapshotError, match="top_inventory_matched_count=6"):
        inv.build_amazon_inventory_snapshot(
            csv_path,
            store_name="Amazon-Test-US",
            output_dir=tmp_path,
            msku_xlsx_path=msku_path,
        )
