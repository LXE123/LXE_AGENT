from __future__ import annotations

import json
from pathlib import Path

import pytest

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
    return path


def _load_records(path: Path, sheet_name: str) -> list[dict]:
    from openpyxl import load_workbook

    workbook = load_workbook(path, data_only=True)
    try:
        worksheet = workbook[sheet_name]
        headers = [cell.value for cell in worksheet[1]]
        return [dict(zip(headers, values, strict=False)) for values in worksheet.iter_rows(min_row=2, values_only=True)]
    finally:
        workbook.close()


def _headers(path: Path, sheet_name: str) -> list[str]:
    from openpyxl import load_workbook

    workbook = load_workbook(path, read_only=True)
    try:
        worksheet = workbook[sheet_name]
        return [cell.value for cell in worksheet[1]]
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
            for row_index in range(1, worksheet.max_row + 1):
                assert worksheet.row_dimensions[row_index].height == 15
            for column_index in range(1, worksheet.max_column + 1):
                assert worksheet.column_dimensions[get_column_letter(column_index)].width == 15
    finally:
        workbook.close()


def _sheet_names(path: Path) -> list[str]:
    from openpyxl import load_workbook

    workbook = load_workbook(path, read_only=True)
    try:
        return list(workbook.sheetnames)
    finally:
        workbook.close()


def _inventory_headers() -> list[str]:
    return ["MSKU", "父ASIN", "ASIN", "本地SKU", "商品链接", "FBA总库存", "加权日销", "可销售天数", "真实库存数量", "子SKU"]


def _sales_headers() -> list[str]:
    return ["MSKU", "父ASIN", "ASIN", "本地SKU", "7天销量", "14天销量", "30天销量", "销量趋势", "单品重量(g)(cm)"]


def _write_inventory_report(path: Path) -> Path:
    headers = _inventory_headers()
    return _write_workbook(
        path,
        {
            "真实库存-组合sku": (
                headers,
                [
                    {
                        "MSKU": "SEA-1",
                        "父ASIN": "PARENT-SEA",
                        "ASIN": "ASIN-SEA",
                        "本地SKU": "COMBO-SEA",
                        "商品链接": "美国 http://www.amazon.com/gp/product/ASIN-SEA",
                        "FBA总库存": 480,
                        "加权日销": 6,
                        "可销售天数": 80,
                        "真实库存数量": 20,
                        "子SKU": "STOCK-A * 1",
                    }
                ],
            ),
            "真实库存-库存sku": (
                headers,
                [
                    {
                        "MSKU": "URGENT-1",
                        "父ASIN": "PARENT-AIR",
                        "ASIN": "ASIN-U",
                        "本地SKU": "SKU-U",
                        "商品链接": "美国 http://www.amazon.com/gp/product/ASIN-U",
                        "FBA总库存": 90,
                        "加权日销": 3,
                        "可销售天数": 30,
                        "真实库存数量": 10,
                    },
                    {
                        "MSKU": "AIR-1",
                        "父ASIN": "PARENT-AIR",
                        "ASIN": "ASIN-A",
                        "本地SKU": "SKU-A",
                        "商品链接": "德国 https://www.amazon.de/dp/ASIN-A",
                        "FBA总库存": 300,
                        "加权日销": 6,
                        "可销售天数": 50,
                        "真实库存数量": 30,
                    },
                    {
                        "MSKU": "NO-1",
                        "父ASIN": "PARENT-NO",
                        "ASIN": "ASIN-N",
                        "本地SKU": "SKU-N",
                        "商品链接": "https://example.test/no",
                        "FBA总库存": 360,
                        "加权日销": 4,
                        "可销售天数": 90,
                        "真实库存数量": 40,
                    },
                    {
                        "MSKU": "SAMPLE-1",
                        "父ASIN": "PARENT-SAMPLE",
                        "ASIN": "ASIN-S",
                        "本地SKU": "SKU-S",
                        "商品链接": "https://example.test/sample",
                        "FBA总库存": 80,
                        "加权日销": 8,
                        "可销售天数": 10,
                        "真实库存数量": 8,
                    },
                ],
            ),
        },
    )


def _write_sales_report(path: Path) -> Path:
    headers = _sales_headers()
    rows = [
        {"MSKU": "SEA-1", "父ASIN": "PARENT-SEA", "ASIN": "ASIN-SEA", "本地SKU": "COMBO-SEA", "7天销量": 42, "14天销量": 84, "30天销量": 180, "销量趋势": "增长", "单品重量(g)(cm)": "120g 10*10*10"},
        {"MSKU": "URGENT-1", "父ASIN": "PARENT-AIR", "ASIN": "ASIN-U", "本地SKU": "SKU-U", "7天销量": 21, "14天销量": 42, "30天销量": 90, "销量趋势": "平稳", "单品重量(g)(cm)": "10"},
        {"MSKU": "AIR-1", "父ASIN": "PARENT-AIR", "ASIN": "ASIN-A", "本地SKU": "SKU-A", "7天销量": 42, "14天销量": 84, "30天销量": 180, "销量趋势": "下降", "单品重量(g)(cm)": "20"},
        {"MSKU": "NO-1", "父ASIN": "PARENT-NO", "ASIN": "ASIN-N", "本地SKU": "SKU-N", "7天销量": 28, "14天销量": 56, "30天销量": 120, "销量趋势": "平稳", "单品重量(g)(cm)": "100"},
        {"MSKU": "SAMPLE-1", "父ASIN": "PARENT-SAMPLE", "ASIN": "ASIN-S", "本地SKU": "SKU-S", "7天销量": 56, "14天销量": 112, "30天销量": 240, "销量趋势": "样本不足", "单品重量(g)(cm)": "50"},
    ]
    return _write_workbook(path, {"MSKU明细": (headers, rows)})


def test_find_matching_report_files_requires_common_source_time(tmp_path) -> None:
    sales_dir = tmp_path / "sales"
    inventory_dir = tmp_path / "inventory"
    _write_sales_report(sales_dir / "202605251530-Amazon-Test_sales_analysis.xlsx")
    _write_inventory_report(inventory_dir / "202605251530-Amazon-Test_actual_inventory.xlsx")
    _write_sales_report(sales_dir / "202605261530-Amazon-Test_sales_analysis.xlsx")

    result = repl.find_matching_report_files(
        "Amazon-Test",
        sales_analysis_dir=sales_dir,
        actual_inventory_dir=inventory_dir,
    )

    assert result.source_data_time == "202605251530"
    assert result.sales_analysis_path.name == "202605251530-Amazon-Test_sales_analysis.xlsx"
    assert result.actual_inventory_path.name == "202605251530-Amazon-Test_actual_inventory.xlsx"


def test_find_matching_report_files_fails_without_common_time(tmp_path) -> None:
    sales_dir = tmp_path / "sales"
    inventory_dir = tmp_path / "inventory"
    _write_sales_report(sales_dir / "202605251530-Amazon-Test_sales_analysis.xlsx")
    _write_inventory_report(inventory_dir / "202605261530-Amazon-Test_actual_inventory.xlsx")

    with pytest.raises(repl.StoreMskuReplenishmentError, match="未找到同源时间"):
        repl.find_matching_report_files("Amazon-Test", sales_analysis_dir=sales_dir, actual_inventory_dir=inventory_dir)


def test_replenishment_rules_and_report_output(tmp_path) -> None:
    sales_dir = tmp_path / "sales"
    inventory_dir = tmp_path / "inventory"
    output_dir = tmp_path / "output"
    sales_path = _write_sales_report(sales_dir / "202605251530-Amazon-Test_sales_analysis.xlsx")
    inventory_path = _write_inventory_report(inventory_dir / "202605251530-Amazon-Test_actual_inventory.xlsx")

    result = repl.calculate_store_msku_replenishment(
        "Amazon-Test",
        sales_analysis_dir=sales_dir,
        actual_inventory_dir=inventory_dir,
        output_dir=output_dir,
    )

    report_path = Path(result.report_xlsx_path)
    assert result.to_payload() == {
        "success": True,
        "store_name": "Amazon-Test",
        "source_data_time": "202605251530",
        "sales_analysis_xlsx_path": str(sales_path),
        "actual_inventory_xlsx_path": str(inventory_path),
        "template_name": "默认模板",
        "template_version": 1,
        "row_count": 5,
        "link_count": 4,
        "air_urgent_count": 1,
        "air_count": 1,
        "sea_count": 1,
        "no_ship_count": 1,
        "sample_insufficient_count": 1,
        "report_xlsx_path": str(output_dir / "202605251530-Amazon-Test_replenishment.xlsx"),
        "source": "mabang_store_msku_replenishment",
    }
    assert report_path.is_file()
    assert _sheet_names(report_path) == ["链接备货汇总", "空运（急发）", "空运", "海运", "暂不建议发货", "样本不足"]
    _assert_standard_dimensions(report_path, _sheet_names(report_path))
    assert _headers(report_path, "链接备货汇总")[-1] == "链接真实本地库存汇总"
    for sheet_name in ["空运（急发）", "空运", "海运", "暂不建议发货", "样本不足"]:
        headers = _headers(report_path, sheet_name)
        assert "真实库存数量" in headers
        assert "真实库存" not in headers
        assert "模板名称" in headers
        assert "命中规则" in headers

    sea_rows = _load_records(report_path, "海运")
    assert sea_rows[0]["MSKU"] == "SEA-1"
    assert sea_rows[0]["补货天数"] == 90
    assert sea_rows[0]["补货量"] == 540
    assert sea_rows[0]["海运天数"] == 90
    assert sea_rows[0]["海运建议量"] == 540
    assert sea_rows[0]["预计总重量kg"] == 64.8
    assert "ceil(6.00*90)=540" in sea_rows[0]["决策原因"]
    assert sea_rows[0]["真实库存数量"] == 20
    assert sea_rows[0]["模板名称"] == "默认模板"
    assert sea_rows[0]["命中规则"] == "默认规则"

    urgent_rows = _load_records(report_path, "空运（急发）")
    assert urgent_rows[0]["MSKU"] == "URGENT-1"
    assert urgent_rows[0]["补货天数"] == 60
    assert urgent_rows[0]["补货量"] == 180
    assert urgent_rows[0]["真实库存数量"] == 10

    air_rows = _load_records(report_path, "空运")
    assert air_rows[0]["MSKU"] == "AIR-1"
    assert air_rows[0]["补货天数"] == 60
    assert air_rows[0]["补货量"] == 360
    assert air_rows[0]["真实库存数量"] == 30

    no_ship_rows = _load_records(report_path, "暂不建议发货")
    assert no_ship_rows[0]["MSKU"] == "NO-1"
    assert no_ship_rows[0]["补货量"] == 240
    assert "加权日销=4.00 <= 5" in no_ship_rows[0]["决策原因"]

    sample_rows = _load_records(report_path, "样本不足")
    assert sample_rows[0]["MSKU"] == "SAMPLE-1"
    assert sample_rows[0]["补货量"] in (None, "")
    assert sample_rows[0]["决策原因"] == "销量趋势为样本不足，不计算备货量"

    summary_rows = _load_records(report_path, "链接备货汇总")
    assert summary_rows[0]["父ASIN"] == "PARENT-SEA"
    assert summary_rows[0]["商品链接"] == "http://www.amazon.com/gp/product/PARENT-SEA"
    assert summary_rows[0]["总补货量"] == 540
    assert summary_rows[0]["海运建议量"] == 540
    assert summary_rows[0]["涉及运输方式"] == "海运"
    assert summary_rows[0]["链接真实本地库存汇总"] == 20
    assert summary_rows[1]["父ASIN"] == "PARENT-AIR"
    assert summary_rows[1]["商品链接"] == "http://www.amazon.com/gp/product/PARENT-AIR"
    assert summary_rows[1]["总补货量"] == 540
    assert summary_rows[1]["空运（急发）补货量"] == 180
    assert summary_rows[1]["空运补货量"] == 360
    assert summary_rows[1]["涉及运输方式"] == "空运（急发）、空运"
    assert summary_rows[1]["链接真实本地库存汇总"] == 40
    assert summary_rows[-1]["父ASIN"] == "PARENT-SAMPLE"
    assert summary_rows[-1]["总补货量"] == 0
    assert summary_rows[-1]["涉及运输方式"] == "样本不足"


def test_parse_weight_grams_uses_first_number() -> None:
    assert repl.parse_weight_grams("120g 10*20*30") == 120
    assert repl.parse_weight_grams("1,200.5g") == 1200.5
    assert repl.parse_weight_grams("") is None


def test_custom_template_changes_replenishment_result(tmp_path, monkeypatch) -> None:
    sales_dir = tmp_path / "sales"
    inventory_dir = tmp_path / "inventory"
    output_dir = tmp_path / "output"
    _write_sales_report(sales_dir / "202605251530-Amazon-Test_sales_analysis.xlsx")
    _write_inventory_report(inventory_dir / "202605251530-Amazon-Test_actual_inventory.xlsx")

    custom_params = tmpl.load_default_template().to_store_payload()
    custom_params["name"] = "保守海运模板"
    custom_params["version"] = 2
    custom_params["params"]["sea"]["min_weight_kg"] = 100
    store_path = tmp_path / "artifacts" / "mabang_replenishment_templates" / "templates.json"
    store_path.parent.mkdir(parents=True, exist_ok=True)
    store_path.write_text(
        json.dumps({"templates": [custom_params]}, ensure_ascii=False),
        encoding="utf-8",
    )
    monkeypatch.chdir(tmp_path)

    result = repl.calculate_store_msku_replenishment(
        "Amazon-Test",
        template_name="保守海运模板",
        sales_analysis_dir=sales_dir,
        actual_inventory_dir=inventory_dir,
        output_dir=output_dir,
    )

    assert result.template_name == "保守海运模板"
    assert result.template_version == 2
    report_path = Path(result.report_xlsx_path)
    sea_rows = _load_records(report_path, "海运")
    no_ship_rows = _load_records(report_path, "暂不建议发货")
    assert sea_rows == []
    assert any(row["MSKU"] == "SEA-1" and "未超过100kg" in row["决策原因"] for row in no_ship_rows)
