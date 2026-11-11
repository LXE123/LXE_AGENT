from contextlib import closing
from datetime import date
from pathlib import Path

from openpyxl import load_workbook
from openpyxl.cell.rich_text import CellRichText, TextBlock
from openpyxl.cell.text import InlineFont
import pytest

from services.philippines_reports.errors import PhilippinesReportError
from services.philippines_reports.sources import INVENTORY_HEADERS
from services.philippines_reports.workbooks import build_reports
from services.yacang.validation import INVENTORY_SALES_DELIVERY_HEADERS


@pytest.fixture
def build(tmp_path):
    def run(paths):
        return build_reports(
            **{key.replace("_file", "_path"): Path(value) if value else None for key, value in paths.items()},
            output_dir=tmp_path / "output", report_date=date(2026, 11, 5),
        )
    return run


def _edit(path, field, value, *, row=2):
    with closing(load_workbook(path)) as book:
        sheet = book.active
        if field == "duplicate":
            sheet.append([cell.value for cell in sheet[2]])
        else:
            cell = sheet.cell(row, [cell.value for cell in sheet[1]].index(field) + 1)
            cell.value = value
        for cells in sheet:
            for empty in cells:
                if empty.value is None and empty.data_type == "inlineStr":
                    empty.value = ""
        book.save(path)
        return cell.data_type if field != "duplicate" else None


def test_matching_fields_added_and_source_only_rows_follow_business_order(ph_files, ph_rows, build):
    zeros = {field: 0 for field in ("库存量", "在途量", "可用库存", "7天销量", "15天销量", "30天销量", "90天销量")}
    paths = ph_files(
        sales=[
            {"SKU": " 001 ", "商品名": "商品", "仓库": "PH8805", "3天销量": 1, "7天销量": 10,
             "15天销量": 20, "30天销量": 30, "60天销量": 60, "90天销量": 90,
             "库存": 11, "占用": 2, "在途": 5, "冻结": 3, "可用": 100, "缺货数量": 4},
            {"SKU": "Y-only", "仓库": "PH8805", "7天销量": -9, "商品名": "", "15天销量": ""},
            {"SKU": "Zero", "仓库": "PH8805", "7天销量": 2},
            {"SKU": "sku", "仓库": "PH8805", "可用": 4},
        ],
        inventory=[
            {"条码": "00018", "SKU": "001", "映射条码": "map-001", "仓库": "PH8805", "规格": "红色",
             "重量(g)": 987, "库存数量": 11, "占用数量": 2, "在途数量": 5, "冻结库存": 3, "可用库存": 100},
            {"SKU": "Y-only", "仓库": "PH8805", "库存数量": 7, "规格": ""},
            {"SKU": "Zero", "仓库": "PH8805", "可用库存": 10},
            {"SKU": "sku", "仓库": "PH8805", "可用库存": -4},
        ],
        tms=[{"仓库": "菲律宾PH1仓", **row} for row in [
            {"库存SKU": "001", "库存量": 4, "在途量": 3, "可用库存": 30,
             "3天销量": 9, "7天销量": 2, "15天销量": 4, "30天销量": 6, "60天销量": 7, "90天销量": 8},
            {"库存SKU": "T-only", "库存量": 2, "在途量": 4, "可用库存": 3},
            {"库存SKU": "Sales-only", "库存量": 0, "在途量": 0, "可用库存": 0, "7天销量": 5},
            {"库存SKU": "Negative", "可用库存": -2},
            {"库存SKU": "Zero", "7天销量": -2, "可用库存": -10},
            {"库存SKU": "new-zero", **zeros, "采购价": 999},
            {"库存SKU": "Blank"},
            {"库存SKU": "90-only", "90天销量": 12},
            {"库存SKU": "=literal-SKU", "可用库存": 1, "7天销量": 1},
            {"库存SKU": "SKU", "可用库存": 5},
            {"库存SKU": "0001", "可用库存": 6},
        ]],
        tms_headers=("库存SKU", "30天销量", "7天销量", "可用库存", "15天销量", "仓库",
                     "库存量", "在途量", "成本价", "采购价", "入库时间", "90天销量", "3天销量", "60天销量"),
    )
    for key, field, address in (("sales_file", "可用", "B3"), ("inventory_file", "可用库存", "F3")):
        _edit(paths[key], field, f" {field} ", row=1)
        with closing(load_workbook(paths[key])) as source:
            assert source.active[address].value is None
            assert source.active[address].data_type == "inlineStr"
    originals = {key: Path(path).read_bytes() for key, path in paths.items()}
    result = build(paths)
    assert [Path(item["path"]).name for item in result["artifacts"]] == [
        "菲律宾库存动销-2026年11月05日.xlsx", "菲律宾库存列表-2026年11月05日.xlsx"]
    sales, inventory = [ph_rows(artifact) for artifact in result["artifacts"]]
    assert tuple(sales[0]) == INVENTORY_SALES_DELIVERY_HEADERS
    assert tuple(inventory[0]) == INVENTORY_HEADERS
    assert [row["SKU"] for row in sales] == ["001", "Y-only", "Sales-only", "=literal-SKU"]
    assert [row["SKU"] for row in inventory] == ["001", "sku", "T-only", "Negative", "=literal-SKU", "SKU", "0001"]
    assert sales[0] == {"SKU": "001", "商品名": "商品", "仓库": "PH8805", "3天销量": 1, "7天销量": 12,
                        "15天销量": 24, "30天销量": 36, "60天销量": 60, "90天销量": 90,
                        "库存": 11, "占用": 2, "在途": 5, "冻结": 3, "可用": 130, "缺货数量": 4}
    assert inventory[0] == {"条码": "00018", "SKU": "001", "映射条码": "map-001", "仓库": "PH8805", "规格": "红色",
                            "库存数量": 11, "占用数量": 2, "在途数量": 5, "冻结库存": 3, "可用库存": 130}
    assert inventory[2] == {"条码": None, "SKU": "T-only", "映射条码": "T-only", "仓库": None, "规格": None,
                            "库存数量": None, "占用数量": None, "在途数量": None, "冻结库存": None, "可用库存": 3}
    assert sales[2]["7天销量"] == 5
    assert sales[2]["商品名"] is None and sales[2]["仓库"] is None
    assert sales[1]["7天销量"] == -9 and inventory[1]["可用库存"] == -4
    assert result["statistics"] == {
        "yacang_sales_rows": 4, "yacang_inventory_rows": 4, "tms_rows": 11, "tms_zero_or_empty_rows": 3,
        "sales_added_rows": 2, "inventory_added_rows": 5, "sales_matched_rows": 1, "inventory_matched_rows": 1}
    assert {key: Path(path).read_bytes() for key, path in paths.items()} == originals
    for artifact in result["artifacts"]:
        with closing(load_workbook(artifact["path"])) as book:
            is_inventory = artifact["report"] == "inventory"
            assert book.sheetnames == (["雅仓库存", "合并库存"] if is_inventory else ["雅仓动销", "合并动销"])
            original = book.worksheets[0]
            assert original["A1"].font.bold
            assert original["A1"].font.color.rgb == "00112233"
            assert original["A1"].fill.fgColor.rgb == "00ABCDEF"
            assert original.column_dimensions["A"].width == 32
            assert original.row_dimensions[1].height == 28
            assert original.freeze_panes == "B2"
            assert not original.sheet_view.showGridLines
            assert book.worksheets[1].cell(6 if is_inventory else 5, 2 if is_inventory else 1).data_type == "s"
            assert original["H2" if is_inventory else "A2"].value == (987 if is_inventory else " 001 ")
            column = 13 if is_inventory else 14
            assert original.cell(1, column).value == (" 可用库存 " if is_inventory else " 可用 ")
            assert original.cell(2, column).value == 100
            assert original["B4" if is_inventory else "A4"].value == "Zero"


def test_decimal_sums_and_blank_rich_text_preserve_original_values(ph_files, ph_rows, build):
    paths = ph_files(
        sales=[{"SKU": CellRichText("00", TextBlock(InlineFont(b=True), "1")), "仓库": "PH8805",
                "商品名": CellRichText("普通", TextBlock(InlineFont(b=True), "加粗")),
                "可用": CellRichText(" ", TextBlock(InlineFont(b=True), " ")),
                "7天销量": "0.1", "15天销量": None, "30天销量": "3", "90天销量": "-"}],
        inventory=[{"SKU": "001", "仓库": "PH8805", "库存数量": "-", "在途数量": " ", "可用库存": -1}],
        tms=[{"库存SKU": "001", "仓库": "菲律宾PH1仓", "库存量": "-", "7天销量": "0.2", "30天销量": "", "可用库存": "-0.5"}],
        tms_headers=("库存SKU", "30天销量", "7天销量", "可用库存", "15天销量", "仓库", "库存量", "在途量", "成本价", "采购价", "入库时间"),
    )
    result = build(paths)
    sales, inventory = [ph_rows(artifact)[0] for artifact in result["artifacts"]]
    assert sales["7天销量"] == 0.3
    assert sales["15天销量"] is None
    assert sales["30天销量"] == "3"
    assert sales["90天销量"] == "-"
    assert inventory["库存数量"] == "-"
    assert inventory["在途数量"] == " "
    assert inventory["可用库存"] == -1.5
    assert sales["SKU"] == "001" and sales["可用"] == -0.5
    with closing(load_workbook(result["artifacts"][0]["path"], rich_text=True)) as book:
        original = book.worksheets[0]
        assert isinstance(original["A2"].value, CellRichText)
        assert isinstance(original["B2"].value, CellRichText)
        assert str(original["B2"].value) == "普通加粗" and original["B2"].value[1].font.b is True
        assert isinstance(original["N2"].value, CellRichText)


@pytest.mark.parametrize("source,numeric,text,sku", [
    ("sales", "7天销量", "商品名", "SKU"),
    ("inventory", "可用库存", "中文标题", "SKU"),
    ("tms", "7天销量", "采购价", "库存SKU"),
])
@pytest.mark.parametrize("field,value,match", [
    ("numeric", "bad", "不是数字"),
    ("numeric", "NaN", "必须是有限数值"),
    ("numeric", "Infinity", "必须是有限数值"),
    ("numeric", True, "不能是布尔值"),
    ("sku", None, "SKU 必须是非空文本"),
    ("sku", 123, "SKU 必须是非空文本"),
    ("duplicate", None, "重复 SKU"),
    ("text", "=1+2", "公式"),
    ("text", "#DIV/0!", "错误"),
])
def test_invalid_sources_publish_nothing(tmp_path, ph_files, build, source, numeric, text, sku, field, value, match):
    paths = ph_files()
    data_type = _edit(paths[f"{source}_file"], {"numeric": numeric, "text": text, "sku": sku}.get(field, field), value)
    if field == "text":
        assert data_type == ("f" if value.startswith("=") else "e")
    with pytest.raises(PhilippinesReportError, match=match) as error:
        build(paths)
    if field == "numeric":
        assert error.value.code == "invalid_number"
    assert not (tmp_path / "output").exists()


def test_second_workbook_save_failure_keeps_sources_and_existing_target(tmp_path, ph_files, build):
    paths = ph_files()
    original = {key: Path(path).read_bytes() for key, path in paths.items()}
    output = tmp_path / "output"
    output.mkdir()
    blocked = output / "菲律宾库存列表-2026年11月05日.xlsx"
    blocked.mkdir()
    (blocked / "keep.txt").write_text("existing unrelated directory", encoding="utf-8")

    with pytest.raises(OSError) as error:
        build(paths)

    assert blocked.name in str(error.value)
    assert (blocked / "keep.txt").read_text(encoding="utf-8") == "existing unrelated directory"
    assert {key: Path(path).read_bytes() for key, path in paths.items()} == original
    with closing(load_workbook(output / "菲律宾库存动销-2026年11月05日.xlsx")) as first:
        assert first.worksheets[1]["N2"].value == 130
