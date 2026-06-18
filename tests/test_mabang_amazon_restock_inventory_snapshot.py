from __future__ import annotations

import csv
from pathlib import Path

import pytest

from services.mabang.amazon.fba import amazon_restock_inventory as inv


def _write_csv(path: Path, rows: list[dict]) -> Path:
    headers = [
        "Country",
        "Product Name",
        "FNSKU",
        "Merchant SKU",
        "ASIN",
        "Condition",
        "Supplier",
        "Supplier part no.",
        "Currency code",
        "Price",
        "Sales last 30 days",
        "Units Sold Last 30 Days",
        "Total Units",
        "Inbound",
        "Available",
        "FC transfer",
        "FC Processing",
        "Customer Order",
        "Unfulfillable",
        "Working",
        "Shipped",
        "Receiving",
        "Fulfilled by",
        "Alert",
        "Recommended replenishment qty",
        "Recommended ship date",
        "Recommended action",
    ]
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=headers)
        writer.writeheader()
        for row in rows:
            writer.writerow(row)
    return path


def _amazon_row(
    sku: str,
    *,
    available: int,
    working: int = 1,
    shipped: int = 2,
    receiving: int = 3,
    fc_transfer: int = 4,
    fc_processing: int = 5,
    customer_order: int = 6,
    unfulfillable: int = 7,
) -> dict:
    inbound = working + shipped + receiving
    total_units = available + inbound + fc_transfer + fc_processing + customer_order
    return {
        "Country": "US",
        "Product Name": f"Product {sku}",
        "FNSKU": f"FNSKU-{sku}",
        "Merchant SKU": sku,
        "ASIN": f"ASIN-{sku}",
        "Condition": "New",
        "Supplier": "",
        "Supplier part no.": "",
        "Currency code": "USD",
        "Price": "9.99",
        "Sales last 30 days": 10,
        "Units Sold Last 30 Days": 10,
        "Total Units": total_units,
        "Inbound": inbound,
        "Available": available,
        "FC transfer": fc_transfer,
        "FC Processing": fc_processing,
        "Customer Order": customer_order,
        "Unfulfillable": unfulfillable,
        "Working": working,
        "Shipped": shipped,
        "Receiving": receiving,
        "Fulfilled by": "Amazon",
        "Alert": "In stock",
        "Recommended replenishment qty": 0,
        "Recommended ship date": "",
        "Recommended action": "",
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


def test_build_amazon_restock_inventory_snapshot_validates_and_writes_snapshot(tmp_path) -> None:
    rows = [_amazon_row(f"MSKU-{index}", available=100 - index) for index in range(1, 10)]
    rows.append(_amazon_row("Amazon.Found.123", available=90))
    csv_path = _write_csv(tmp_path / "restock.csv", rows)
    msku_path = _write_mabang_msku(
        tmp_path / "msku.xlsx",
        [f"MSKU-{index}" for index in range(1, 8)] + ["Amazon.Found.123"],
    )

    result = inv.build_amazon_restock_inventory_snapshot(
        csv_path,
        store_name="Amazon-Test-US",
        output_dir=tmp_path,
        msku_xlsx_path=msku_path,
        snapshot_time="202606211530",
        snapshot_date="20260621",
    )

    payload = result.to_payload()
    assert payload["snapshot_xlsx_path"] == str(tmp_path / "202606211530-Amazon-Test-US_亚马逊补充库存快照.xlsx")
    assert payload["snapshot_date"] == "20260621"
    assert payload["msku_count"] == 10
    assert payload["amazon_restock_inventory_validation"] == {
        "country": "US",
        "mabang_site": "美国站",
        "amazon_sku_count": 10,
        "matched_amazon_sku_count": 8,
        "amazon_sku_match_ratio": 0.8,
        "top_inventory_sku_count": 10,
        "top_inventory_matched_count": 8,
    }

    snapshot = inv.load_amazon_restock_inventory_snapshot(result.snapshot_xlsx_path, store_name="Amazon-Test-US")
    assert snapshot.snapshot_date == "20260621"
    assert snapshot.quantities_by_msku["MSKU-1"] == 120
    assert snapshot.quantities_by_msku["Amazon.Found.123"] == 111
    assert snapshot.validation is not None
    assert snapshot.validation.top_inventory_matched_count == 8


def test_total_units_does_not_include_unfulfillable(tmp_path) -> None:
    csv_path = _write_csv(tmp_path / "restock.csv", [_amazon_row("MSKU-1", available=10, unfulfillable=999)])
    msku_path = _write_mabang_msku(tmp_path / "msku.xlsx", ["MSKU-1"])

    result = inv.build_amazon_restock_inventory_snapshot(
        csv_path,
        store_name="Amazon-Test-US",
        output_dir=tmp_path,
        msku_xlsx_path=msku_path,
        snapshot_time="202606211530",
        snapshot_date="20260621",
    )

    assert result.total_amazon_restock_inventory == 31


def test_inbound_formula_mismatch_fails(tmp_path) -> None:
    row = _amazon_row("MSKU-1", available=10)
    row["Inbound"] = 999
    csv_path = _write_csv(tmp_path / "restock.csv", [row])
    msku_path = _write_mabang_msku(tmp_path / "msku.xlsx", ["MSKU-1"])

    with pytest.raises(inv.AmazonRestockInventorySnapshotError, match="Inbound 公式不一致"):
        inv.build_amazon_restock_inventory_snapshot(
            csv_path,
            store_name="Amazon-Test-US",
            output_dir=tmp_path,
            msku_xlsx_path=msku_path,
            snapshot_date="20260621",
        )


def test_total_units_formula_mismatch_fails(tmp_path) -> None:
    row = _amazon_row("MSKU-1", available=10)
    row["Total Units"] = 999
    csv_path = _write_csv(tmp_path / "restock.csv", [row])
    msku_path = _write_mabang_msku(tmp_path / "msku.xlsx", ["MSKU-1"])

    with pytest.raises(inv.AmazonRestockInventorySnapshotError, match="Total Units 公式不一致"):
        inv.build_amazon_restock_inventory_snapshot(
            csv_path,
            store_name="Amazon-Test-US",
            output_dir=tmp_path,
            msku_xlsx_path=msku_path,
            snapshot_date="20260621",
        )


def test_low_amazon_sku_match_ratio_fails(tmp_path) -> None:
    csv_path = _write_csv(
        tmp_path / "restock.csv",
        [_amazon_row(f"MSKU-{index}", available=100 - index) for index in range(1, 11)],
    )
    msku_path = _write_mabang_msku(tmp_path / "msku.xlsx", [f"MSKU-{index}" for index in range(1, 7)])

    with pytest.raises(inv.AmazonRestockInventorySnapshotError, match="sku_match_ratio=0.6000"):
        inv.build_amazon_restock_inventory_snapshot(
            csv_path,
            store_name="Amazon-Test-US",
            output_dir=tmp_path,
            msku_xlsx_path=msku_path,
            snapshot_date="20260621",
        )


def test_low_top_inventory_sku_match_count_fails(tmp_path) -> None:
    high_rows = [_amazon_row(f"HIGH-{index}", available=1000 - index) for index in range(1, 11)]
    low_rows = [_amazon_row(f"LOW-{index}", available=100 - index) for index in range(1, 11)]
    csv_path = _write_csv(tmp_path / "restock.csv", [*high_rows, *low_rows])
    matched_mskus = [f"HIGH-{index}" for index in range(1, 7)] + [f"LOW-{index}" for index in range(1, 9)]
    msku_path = _write_mabang_msku(tmp_path / "msku.xlsx", matched_mskus)

    with pytest.raises(inv.AmazonRestockInventorySnapshotError, match="top_inventory_matched_count=6"):
        inv.build_amazon_restock_inventory_snapshot(
            csv_path,
            store_name="Amazon-Test-US",
            output_dir=tmp_path,
            msku_xlsx_path=msku_path,
            snapshot_date="20260621",
        )
