from __future__ import annotations

import json
from pathlib import Path

import pytest

from mabang_test_helpers import _sheet_names, _stamp_active_test_report
from services.mabang.amazon.fba import store_msku_replenishment as repl
from services.mabang.amazon.fba import replenishment_template as tmpl


def _write_workbook(path: Path, sheets: dict[str, tuple[list[str], list[dict]]]) -> Path:
    from openpyxl import Workbook

    path.parent.mkdir(parents=True, exist_ok=True)
    workbook = Workbook()
    try:
        for index, (sheet_name, (headers, rows)) in enumerate(sheets.items()):
            worksheet = workbook.active if index == 0 else workbook.create_sheet()
            worksheet.title = sheet_name
            worksheet.append(headers)
            for row in rows:
                worksheet.append([row.get(header, "") for header in headers])
        workbook.save(path)
    finally:
        workbook.close()
    if path.name[:12].isdigit() and "-" in path.name:
        _stamp_active_test_report(path)
    return path


def _read_sales_details(path):
    from openpyxl import load_workbook
    book = load_workbook(path, data_only=True)
    try:
        values = book["MSKU明细"].iter_rows(values_only=True)
        headers = next(values)
        return {record["MSKU"]: repl.sales_detail_from_record(record)
                for record in (dict(zip(headers, row)) for row in values)}
    finally:
        book.close()


def _load_records(path: Path, sheet_name: str) -> list[dict]:
    from openpyxl import load_workbook

    workbook = load_workbook(path, data_only=True)
    try:
        worksheet = workbook[sheet_name]
        header_row = 2 if sheet_name in {"最终备货意见", "本轮不备货"} else 1
        headers = [cell.value for cell in worksheet[header_row]]
        return [dict(zip(headers, values, strict=False)) for values in worksheet.iter_rows(min_row=header_row + 1, values_only=True)]
    finally:
        workbook.close()


def _headers(path: Path, sheet_name: str) -> list[str]:
    from openpyxl import load_workbook

    workbook = load_workbook(path, read_only=True)
    try:
        worksheet = workbook[sheet_name]
        return [cell.value for cell in worksheet[2 if sheet_name in {"最终备货意见", "本轮不备货"} else 1]]
    finally:
        workbook.close()


def _column_number_formats(path: Path, sheet_name: str, header: str) -> list[str]:
    from openpyxl import load_workbook

    workbook = load_workbook(path)
    try:
        worksheet = workbook[sheet_name]
        headers = [cell.value for cell in worksheet[2 if sheet_name == "最终备货意见" else 1]]
        column_index = headers.index(header) + 1
        return [
            worksheet.cell(row=row_index, column=column_index).number_format
            for row_index in range(2, worksheet.max_row + 1)
        ]
    finally:
        workbook.close()


def _assert_standard_dimensions(path: Path, sheet_names: list[str]) -> None:
    from openpyxl import load_workbook
    from openpyxl.utils import get_column_letter

    workbook = load_workbook(path)
    try:
        for sheet_name in sheet_names:
            worksheet = workbook[sheet_name]
            assert worksheet.sheet_format.defaultRowHeight == 15
            assert worksheet.sheet_format.defaultColWidth == 15
            for row_index in range(1, worksheet.max_row + 1):
                assert worksheet.row_dimensions[row_index].height == 15
            for column_index in range(1, worksheet.max_column + 1):
                assert worksheet.column_dimensions[get_column_letter(column_index)].width == 15
    finally:
        workbook.close()


def _inventory_headers() -> list[str]:
    return ["MSKU", "父ASIN", "ASIN", "本地SKU", "本地SKU名称", "产品名称", "备注", "商品链接", "FBA总库存", "加权日销", "可销售天数", "真实库存（深圳仓库）数量", "子SKU"]


def _sales_headers() -> list[str]:
    return ["MSKU", "父ASIN", "ASIN", "本地SKU", *repl.SOURCE_VALUE_COLUMNS, "销量趋势速率", "销量趋势", "单品重量(g)(cm)"]


def _replenishment_row(
    msku: str,
    sheet_name: str,
    *,
    replenish_quantity: int | None,
    actual_inventory: float | None,
) -> repl.ReplenishmentRow:
    return repl.ReplenishmentRow(
        msku=msku,
        parent_asin=f"PARENT-{msku}",
        asin=f"ASIN-{msku}",
        local_sku=f"SKU-{msku}",
        local_sku_name=f"本地名-{msku}",
        product_name=f"产品名-{msku}",
        remark="",
        product_link=f"https://example.test/{msku}",
        sku_type="库存sku",
        template_name="默认",
        matched_rule="默认规则",
        sales_trend="平稳",
        trend_group="平稳",
        weighted_daily_sales=1,
        sales_days=10,
        fba_total_inventory=10,
        unlinked_quantity=0,
        actual_inventory=actual_inventory,
        weight_grams=100,
        replenish_days=10 if replenish_quantity is not None else None,
        replenish_quantity=replenish_quantity,
        original_replenish_quantity=replenish_quantity,
        sea_days=None,
        sea_quantity=None,
        estimated_weight_kg=None,
        decision_reason="测试",
        child_skus="",
        sheet_name=sheet_name,
    )


def _inventory_input_row(msku: str, *, fba_total_inventory: float) -> repl.InventoryInputRow:
    return repl.InventoryInputRow(
        msku=msku,
        parent_asin=f"PARENT-{msku}",
        asin=f"ASIN-{msku}",
        local_sku=f"SKU-{msku}",
        local_sku_name=f"本地名-{msku}",
        product_name=f"产品名-{msku}",
        remark="",
        product_link=f"https://example.test/{msku}",
        sku_type="库存sku",
        weighted_daily_sales=0,
        sales_days=None,
        fba_total_inventory=fba_total_inventory,
        actual_inventory=999,
        child_skus="",
    )


def _sales_detail_for_daily_sales(daily_sales: float, *, weight_grams: float) -> repl.SalesDetail:
    return repl.SalesDetail(
        trend="平稳",
        weight_grams=weight_grams,
        sales_7d=daily_sales * 7,
        sales_14d=daily_sales * 14,
        sales_30d=daily_sales * 30,
    )


def _write_inventory_report(path: Path, *, remarks: dict[str, str] | None = None) -> Path:
    headers = _inventory_headers()
    remarks = dict(remarks or {})
    return _write_workbook(
        path,
        {
            "真实库存（深圳仓库）-组合sku": (
                headers,
                [
                    {
                        "MSKU": "SEA-1",
                        "父ASIN": "PARENT-SEA",
                        "ASIN": "ASIN-SEA",
                        "本地SKU": "COMBO-SEA",
                        "本地SKU名称": "海运组合本地名",
                        "产品名称": "Sea Combo Product",
                        "备注": remarks.get("SEA-1", ""),
                        "商品链接": "美国 http://www.amazon.com/gp/product/ASIN-SEA",
                        "FBA总库存": 480,
                        "加权日销": 6,
                        "可销售天数": 80,
                        "真实库存（深圳仓库）数量": 20,
                        "子SKU": "STOCK-A * 1",
                    }
                ],
            ),
            "真实库存（深圳仓库）-库存sku": (
                headers,
                [
                    {
                        "MSKU": "URGENT-1",
                        "父ASIN": "PARENT-AIR",
                        "ASIN": "ASIN-U",
                        "本地SKU": "SKU-U",
                        "本地SKU名称": "急发本地名",
                        "产品名称": "Urgent Product",
                        "备注": remarks.get("URGENT-1", ""),
                        "商品链接": "美国 http://www.amazon.com/gp/product/ASIN-U",
                        "FBA总库存": 90,
                        "加权日销": 3,
                        "可销售天数": 30,
                        "真实库存（深圳仓库）数量": 10,
                    },
                    {
                        "MSKU": "AIR-1",
                        "父ASIN": "PARENT-AIR",
                        "ASIN": "ASIN-A",
                        "本地SKU": "SKU-A",
                        "本地SKU名称": "空运本地名",
                        "产品名称": "Air Product",
                        "备注": remarks.get("AIR-1", ""),
                        "商品链接": "德国 https://www.amazon.de/dp/ASIN-A",
                        "FBA总库存": 300,
                        "加权日销": 6,
                        "可销售天数": 50,
                        "真实库存（深圳仓库）数量": 30,
                    },
                    {
                        "MSKU": "NO-1",
                        "父ASIN": "PARENT-NO",
                        "ASIN": "ASIN-N",
                        "本地SKU": "SKU-N",
                        "本地SKU名称": "暂不发货本地名",
                        "产品名称": "No Ship Product",
                        "备注": remarks.get("NO-1", ""),
                        "商品链接": "https://example.test/no",
                        "FBA总库存": 360,
                        "加权日销": 4,
                        "可销售天数": 90,
                        "真实库存（深圳仓库）数量": 40,
                    },
                    {
                        "MSKU": "SAMPLE-1",
                        "父ASIN": "PARENT-SAMPLE",
                        "ASIN": "ASIN-S",
                        "本地SKU": "SKU-S",
                        "本地SKU名称": "样本不足本地名",
                        "产品名称": "Sample Product",
                        "备注": remarks.get("SAMPLE-1", ""),
                        "商品链接": "https://example.test/sample",
                        "FBA总库存": 80,
                        "加权日销": 8,
                        "可销售天数": 10,
                        "真实库存（深圳仓库）数量": 8,
                    },
                ],
            ),
        },
    )


def _write_sales_report(path: Path) -> Path:
    headers = _sales_headers()
    rows = [
        {"MSKU": "SEA-1", "父ASIN": "PARENT-SEA", "ASIN": "ASIN-SEA", "本地SKU": "COMBO-SEA", "7天销量": 42, "14天销量": 84, "30天销量": 180, "销量趋势速率": 1.5, "销量趋势": "增长", "单品重量(g)(cm)": "1200g 10*10*10"},
        {"MSKU": "URGENT-1", "父ASIN": "PARENT-AIR", "ASIN": "ASIN-U", "本地SKU": "SKU-U", "7天销量": 21, "14天销量": 42, "30天销量": 90, "销量趋势速率": 1, "销量趋势": "平稳", "单品重量(g)(cm)": "10"},
        {"MSKU": "AIR-1", "父ASIN": "PARENT-AIR", "ASIN": "ASIN-A", "本地SKU": "SKU-A", "7天销量": 42, "14天销量": 84, "30天销量": 180, "销量趋势速率": 0.8, "销量趋势": "下降", "单品重量(g)(cm)": "20"},
        {"MSKU": "NO-1", "父ASIN": "PARENT-NO", "ASIN": "ASIN-N", "本地SKU": "SKU-N", "7天销量": 28, "14天销量": 56, "30天销量": 120, "销量趋势速率": 1, "销量趋势": "平稳", "单品重量(g)(cm)": "100"},
        {"MSKU": "SAMPLE-1", "父ASIN": "PARENT-SAMPLE", "ASIN": "ASIN-S", "本地SKU": "SKU-S", "7天销量": 56, "14天销量": 112, "30天销量": 240, "销量趋势速率": "", "销量趋势": "样本不足", "单品重量(g)(cm)": "50"},
    ]
    totals = {"SEA-1": 480, "URGENT-1": 90, "AIR-1": 300, "NO-1": 360, "SAMPLE-1": 80}
    for row in rows:
        row.update({"90天销量": row["30天销量"] * 3, "可售": totals[row["MSKU"]],
                    "待入库": 0, "预留": 0, "计划入库": 0, "在途": 0, "待调仓": "0", "调仓中": "0"})
    return _write_workbook(path, {"MSKU明细": (headers, rows)})


def test_load_inventory_rows_allows_missing_optional_name_columns(tmp_path) -> None:
    path = tmp_path / "202605251530-Amazon-Test_真实库存.xlsx"
    old_headers = [
        "MSKU",
        "父ASIN",
        "ASIN",
        "本地SKU",
        "商品链接",
        "FBA总库存",
        "加权日销",
        "可销售天数",
        "真实库存（深圳仓库）数量",
        "子SKU",
    ]
    _write_workbook(
        path,
        {
            "真实库存（深圳仓库）-组合sku": (
                old_headers,
                [
                    {
                        "MSKU": "MSKU-C",
                        "父ASIN": "PARENT-C",
                        "ASIN": "ASIN-C",
                        "本地SKU": "COMBO-C",
                        "商品链接": "https://example.test/c",
                        "FBA总库存": 10,
                        "加权日销": 1,
                        "可销售天数": 10,
                        "真实库存（深圳仓库）数量": 5,
                        "子SKU": "SKU-A * 1",
                    }
                ],
            ),
            "真实库存（深圳仓库）-库存sku": (old_headers, []),
        },
    )

    rows = repl.load_inventory_rows(path)

    assert len(rows) == 1
    assert rows[0].local_sku_name == ""
    assert rows[0].product_name == ""


def test_load_inventory_rows_accepts_legacy_actual_inventory_sheet_and_column(tmp_path) -> None:
    path = tmp_path / "202605251530-Amazon-Test_真实库存.xlsx"
    headers = [
        "MSKU",
        "父ASIN",
        "ASIN",
        "本地SKU",
        "商品链接",
        "FBA总库存",
        "加权日销",
        "可销售天数",
        "真实库存数量",
        "子SKU",
    ]
    _write_workbook(
        path,
        {
            "真实库存-组合sku": (
                headers,
                [
                    {
                        "MSKU": "MSKU-C",
                        "父ASIN": "PARENT-C",
                        "ASIN": "ASIN-C",
                        "本地SKU": "COMBO-C",
                        "商品链接": "https://example.test/c",
                        "FBA总库存": 10,
                        "加权日销": 1,
                        "可销售天数": 10,
                        "真实库存数量": 5,
                        "子SKU": "SKU-A * 1",
                    }
                ],
            ),
            "真实库存-库存sku": (headers, []),
        },
    )

    rows = repl.load_inventory_rows(path)

    assert len(rows) == 1
    assert rows[0].sku_type == "组合sku"
    assert rows[0].actual_inventory == 5


def test_inventory_shortage_rows_only_include_suggested_rows_with_known_shortage() -> None:
    rows = [
        _replenishment_row("URGENT", repl.AIR_URGENT_SHEET, replenish_quantity=100, actual_inventory=20),
        _replenishment_row("AIR", repl.AIR_SHEET, replenish_quantity=100, actual_inventory=99.5),
        _replenishment_row("SEA", repl.SEA_SHEET, replenish_quantity=100, actual_inventory=80),
        _replenishment_row("ENOUGH", repl.AIR_SHEET, replenish_quantity=100, actual_inventory=100),
        _replenishment_row("UNKNOWN", repl.AIR_SHEET, replenish_quantity=100, actual_inventory=None),
        _replenishment_row("NO-SHIP", repl.NO_SHIP_SHEET, replenish_quantity=100, actual_inventory=0),
        _replenishment_row("SAMPLE", repl.SAMPLE_INSUFFICIENT_SHEET, replenish_quantity=None, actual_inventory=0),
    ]

    shortage_rows = repl.inventory_shortage_rows(rows)

    assert [row["MSKU"] for row in shortage_rows] == ["URGENT", "AIR", "SEA"]
    assert [row["运输渠道"] for row in shortage_rows] == ["空运（急发）", "空运", "海运"]
    assert shortage_rows[0]["库存缺口"] == 80
    assert shortage_rows[1]["库存缺口"] == 0.5
    assert shortage_rows[2]["库存缺口"] == 20


def test_parse_weight_grams_uses_first_number() -> None:
    assert repl.parse_weight_grams("120g 10*20*30") == 120
    assert repl.parse_weight_grams("1,200.5g") == 1200.5
    assert repl.parse_weight_grams("") is None


def test_detail_payload_estimated_weight_uses_final_replenishment_quantity() -> None:
    air_row = _replenishment_row("AIR-WEIGHT", repl.AIR_SHEET, replenish_quantity=80, actual_inventory=10)
    no_ship_row = _replenishment_row("NO-SHIP-WEIGHT", repl.NO_SHIP_SHEET, replenish_quantity=80, actual_inventory=10)

    assert air_row.to_detail_payload()["预计总重量kg"] == 8
    assert no_ship_row.to_detail_payload()["预计总重量kg"] == ""


def test_lin_meiqi_group_2_template_uses_inclusive_one_day_sea_threshold() -> None:
    template = tmpl.get_template("2组-US站点-林美淇")

    row = repl.calculate_replenishment_row(
        _inventory_input_row("DAILY-1", fba_total_inventory=100),
        _sales_detail_for_daily_sales(1, weight_grams=2100),
        template,
    )

    assert row.sheet_name == repl.NO_SHIP_SHEET
    assert row.weighted_daily_sales == pytest.approx(1)
    assert row.sales_days == pytest.approx(100)
    assert row.replenish_days == 100
    assert row.replenish_quantity == 0
    assert row.original_replenish_quantity == 100
    assert row.fba_deducted_replenish_quantity == 0
    assert row.sea_days == 100
    assert row.sea_quantity == 0
    assert row.companion_air_days == 70
    assert row.companion_air_quantity == 0
    assert row.sea_net_quantity == 0
    assert row.estimated_weight_kg is None


def test_lin_meiqi_group_2_template_keeps_eighty_sales_days_in_air() -> None:
    template = tmpl.get_template("2组-US站点-林美淇")

    row = repl.calculate_replenishment_row(
        _inventory_input_row("DAILY-6-AIR", fba_total_inventory=480),
        _sales_detail_for_daily_sales(6, weight_grams=610),
        template,
    )

    assert row.sheet_name == repl.NO_SHIP_SHEET
    assert row.sales_days == pytest.approx(80)
    assert row.replenish_days == 80
    assert row.original_replenish_quantity == 480
    assert row.fba_deducted_replenish_quantity == 0
    assert row.replenish_quantity == 0


def test_lin_meiqi_group_2_template_rejects_below_one_day_sea() -> None:
    template = tmpl.get_template("2组-US站点-林美淇")

    row = repl.calculate_replenishment_row(
        _inventory_input_row("DAILY-BELOW-1", fba_total_inventory=100),
        _sales_detail_for_daily_sales(0.99, weight_grams=1000),
        template,
    )

    assert row.sheet_name == repl.NO_SHIP_SHEET
    assert row.weighted_daily_sales == pytest.approx(0.99)


def test_lin_meiqi_group_2_template_uses_120_day_sea_above_twenty_daily_sales() -> None:
    template = tmpl.get_template("2组-US站点-林美淇")

    row = repl.calculate_replenishment_row(
        _inventory_input_row("DAILY-21", fba_total_inventory=2000),
        _sales_detail_for_daily_sales(21, weight_grams=200),
        template,
    )

    assert row.sheet_name == repl.SEA_SHEET
    assert row.weighted_daily_sales == pytest.approx(21)
    assert row.sales_days == pytest.approx(2000 / 21)
    assert row.replenish_days == 120
    assert row.replenish_quantity == 520
    assert row.original_replenish_quantity == 2520
    assert row.fba_deducted_replenish_quantity == 520
    assert row.sea_days == 120
    assert row.sea_quantity == 520
    assert row.companion_air_days == 80
    assert row.companion_air_quantity == 0
    assert row.sea_net_quantity == 520
    assert row.estimated_weight_kg == pytest.approx(104)


def test_lin_meiqi_group_2_template_treats_above_three_hundred_as_above_twenty() -> None:
    template = tmpl.get_template("2组-US站点-林美淇")

    row = repl.calculate_replenishment_row(
        _inventory_input_row("DAILY-301", fba_total_inventory=30000),
        _sales_detail_for_daily_sales(301, weight_grams=10),
        template,
    )

    assert row.sheet_name == repl.SEA_SHEET
    assert row.replenish_days == 120
    assert row.replenish_quantity == 6120
    assert row.original_replenish_quantity == 36120
    assert row.fba_deducted_replenish_quantity == 6120
    assert row.sea_days == 120
    assert row.sea_quantity == 6120
    assert row.companion_air_days == 80
    assert row.companion_air_quantity == 0
    assert row.sea_net_quantity == 6120
    assert row.estimated_weight_kg == pytest.approx(61.2)


def test_lin_meiqi_group_2_template_deducts_unlinked_after_companion_air() -> None:
    template = tmpl.get_template("2组-US站点-林美淇")

    row = repl.calculate_replenishment_row(
        _inventory_input_row("DAILY-6-UNLINKED", fba_total_inventory=600),
        _sales_detail_for_daily_sales(6, weight_grams=1300),
        template,
        unlinked_quantity=10,
    )

    assert row.sheet_name == repl.SEA_SHEET
    assert row.original_replenish_quantity == 660
    assert row.fba_deducted_replenish_quantity == 60
    assert row.replenish_quantity == 50
    assert row.sea_quantity == 50
    assert row.companion_air_quantity == 0
    assert row.sea_net_quantity == 50
    assert row.estimated_weight_kg == pytest.approx(65)


def test_lin_meiqi_group_2_template_deducts_unlinked_from_sea_after_companion_air() -> None:
    template = tmpl.get_template("2组-US站点-林美淇")

    row = repl.calculate_replenishment_row(
        _inventory_input_row("DAILY-6-UNLINKED-SEA", fba_total_inventory=500),
        _sales_detail_for_daily_sales(6, weight_grams=600),
        template,
        unlinked_quantity=50,
    )

    assert row.sheet_name == repl.SEA_SHEET
    assert row.original_replenish_quantity == 660
    assert row.fba_deducted_replenish_quantity == 160
    assert row.replenish_quantity == 110
    assert row.sea_quantity == 110
    assert row.companion_air_quantity == 0
    assert row.sea_net_quantity == 110
    assert row.estimated_weight_kg == pytest.approx(66)


def test_lin_meiqi_group_2_template_rejects_small_net_sea_quantity() -> None:
    template = tmpl.get_template("2组-US站点-林美淇")
    params = json.loads(json.dumps(template.params, ensure_ascii=False))
    params["sea"]["min_net_quantity"] = 61
    custom_template = tmpl.ReplenishmentTemplate(
        name="小净量测试方案",
        version=1,
        description="",
        params=params,
    )

    row = repl.calculate_replenishment_row(
        _inventory_input_row("DAILY-6-SMALL-NET", fba_total_inventory=600),
        _sales_detail_for_daily_sales(6, weight_grams=2100),
        custom_template,
    )

    assert row.sheet_name == repl.NO_SHIP_SHEET
    assert row.original_replenish_quantity == 660
    assert row.fba_deducted_replenish_quantity == 60
    assert row.replenish_quantity == 60
    assert row.sea_quantity == 60
    assert row.companion_air_quantity == 0
    assert row.sea_net_quantity == 60


def test_lin_meiqi_group_2_template_accepts_small_net_sea_weight() -> None:
    template = tmpl.get_template("2组-US站点-林美淇")

    row = repl.calculate_replenishment_row(
        _inventory_input_row("DAILY-6-LIGHT-NET", fba_total_inventory=600),
        _sales_detail_for_daily_sales(6, weight_grams=100),
        template,
    )

    assert row.sheet_name == repl.SEA_SHEET
    assert row.replenish_days == 110
    assert row.original_replenish_quantity == 660
    assert row.fba_deducted_replenish_quantity == 60
    assert row.replenish_quantity == 60
    assert row.sea_quantity == 60
    assert row.companion_air_days == 75
    assert row.companion_air_quantity == 0
    assert row.sea_net_quantity == 60
    assert row.estimated_weight_kg == 6


def test_lin_meiqi_group_2_template_rejects_unlinked_deduction_below_min_sea_quantity() -> None:
    template = tmpl.get_template("2组-US站点-林美淇")

    row = repl.calculate_replenishment_row(
        _inventory_input_row("DAILY-6-UNLINKED-SMALL-SEA", fba_total_inventory=500),
        _sales_detail_for_daily_sales(6, weight_grams=400),
        template,
        unlinked_quantity=131,
    )

    assert row.sheet_name == repl.NO_SHIP_SHEET
    assert row.original_replenish_quantity == 660
    assert row.fba_deducted_replenish_quantity == 160
    assert row.replenish_quantity == 29
    assert row.sea_quantity == 29
    assert row.companion_air_quantity == 0
    assert row.sea_net_quantity == 29
    assert row.estimated_weight_kg is None
