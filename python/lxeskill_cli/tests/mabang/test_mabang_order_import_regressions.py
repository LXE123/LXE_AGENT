from datetime import date
from io import BytesIO
from xml.etree import ElementTree as ET
from zipfile import ZipFile

import pytest
from openpyxl import Workbook
from openpyxl.styles import PatternFill

from services.mabang.order_import import country_rules
from services.mabang.order_import.source import nearest_occurrence
from services.mabang.order_import.workbook import OrderImportWorkbookError
from order_import_test_helpers import TEMPLATE, TODAY, open_sheet, rows, source_workbook


NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"


def edit_xml(path, edit):
    updated = BytesIO()
    with ZipFile(path) as original, ZipFile(updated, "w") as archive:
        for item in original.infolist():
            data = original.read(item.filename)
            if item.filename == "xl/worksheets/sheet1.xml":
                root = ET.fromstring(data)
                edit(root)
                data = ET.tostring(root, encoding="utf-8")
            archive.writestr(item, data)
    path.write_bytes(updated.getvalue())


def formula_cache(path, coordinate, data_type="str", value=None, cached=True, implicit=False):
    # openpyxl cannot create caches; manipulate the actual XLSX encoding.
    def edit(root):
        cell = root.find(f".//{NS}c[@r='{coordinate}']")
        for child in list(cell):
            cell.remove(child)
        cell.set("t", data_type)
        ET.SubElement(cell, f"{NS}f").text = 'IF(TRUE,"",1)'
        if cached:
            ET.SubElement(cell, f"{NS}v").text = value
        if implicit:
            cell.attrib.pop("r")
            root.find(f".//{NS}row[@r='2']").attrib.pop("r")
    edit_xml(path, edit)


@pytest.fixture
def source(tmp_path):
    return source_workbook(tmp_path / "source.xlsx")


def generate(source):
    return country_rules.generate_order_workbooks(
        "vietnam", source, source.parent / "out", today=TODAY,
        shipping_column=None, template_path=TEMPLATE,
    )[0]


def test_stale_dimensions_and_values(source):
    with open_sheet(source) as sheet:
        for row, quantity in enumerate([10, 0.1, 2.5, "12.5", 0, "0", None], 2):
            sheet.cell(row, 5, f"SKU-{row}")
            sheet.cell(row, 41).value = quantity
        sheet["E2"] = "#N/A"
        sheet["E2"].data_type = "s"
        sheet.parent.save(source)
    edit_xml(source, lambda root: root.find(f"{NS}dimension").set("ref", "A1:AO2"))
    result = generate(source)
    with open_sheet(result["output_xlsx"]) as sheet:
        assert rows(sheet) == [(sku, 0, q) for sku, q in zip(
            ["#N/A", "SKU-3", "SKU-4", "SKU-5", "SKU-6", "SKU-7", "SKU-8"],
            [10, 0.1, 2.5, 12.5, None, None, None], strict=True)]
        assert sheet["D2"].data_type == "s"
    assert (result["sku_count"], result["quantity_value_count"]) == (7, 4)


@pytest.mark.parametrize(("coordinate", "value", "formula", "error"), [
    ("E2", "#N/A", False, "#N/A"), ("E2", "#N/A", True, "#N/A"),
    ("AO3", "9007199254740993", False, "数量.*精度"), ("AO3", "1e-400", False, "数量.*范围"),
    ("AO2", -1, False, "数量"), ("AO2", "bad", False, "数量"),
    ("AO2", True, False, "数量"), ("AO2", "NaN", False, "数量"),
])
def test_invalid_cells(source, coordinate, value, formula, error):
    with open_sheet(source) as sheet:
        sheet[coordinate] = value
        sheet.parent.save(source)
    if formula:
        formula_cache(source, coordinate, "e", value)
    with pytest.raises(OrderImportWorkbookError, match=rf"{coordinate}.*{error}"):
        generate(source)
    assert list(source.parent.rglob("*.xlsx")) == [source]


@pytest.mark.parametrize("quantity", [0, 30])
def test_cached_formula_and_literal_sku(source, quantity):
    with open_sheet(source) as sheet:
        sheet["E3"] = "=SKU-LITERAL"
        sheet["E3"].data_type = "s"
        sheet["AO4"] = 30
        sheet["AQ2"] = "=1+1"  # An unused quantity formula must not block export.
        sheet.parent.save(source)
    formula_cache(source, "E2", "str", "SKU-CACHED")
    formula_cache(source, "AO2", "n", str(quantity))
    result = generate(source)
    with open_sheet(result["output_xlsx"]) as sheet:
        assert rows(sheet) == [("SKU-CACHED", 0, quantity or None), ("=SKU-LITERAL", 0, None), ("SKU-A", 0, 30)]
        assert sheet["D3"].data_type == "s"
    assert result["quantity_value_count"] == (1 if quantity == 0 else 2)


@pytest.mark.parametrize(("coordinate", "cached", "implicit"), [
    ("E2", True, False), ("E2", False, False), ("AO2", True, False),
    ("AO2", False, False), ("AO2", True, True),
])
def test_empty_formula_cache(source, coordinate, cached, implicit):
    with open_sheet(source) as sheet:
        sheet["AN2"] = "preceding column"
        sheet.parent.save(source)
    formula_cache(source, coordinate, cached=cached, implicit=implicit)
    if not cached:
        with pytest.raises(OrderImportWorkbookError, match=rf"{coordinate}.*公式.*缓存"):
            generate(source)
        assert list(source.parent.rglob("*.xlsx")) == [source]
        return
    result = generate(source)
    expected = ["SKU-B", "SKU-A"] if coordinate == "E2" else ["SKU-A", "SKU-B", "SKU-A"]
    with open_sheet(result["output_xlsx"]) as sheet:
        assert rows(sheet) == [(sku, 0, None) for sku in expected]
    assert (result["sku_count"], result["quantity_value_count"]) == (len(expected), 0)


@pytest.mark.parametrize("coordinate", ["E2", "AO2"])
def test_existing_output_survives_missing_cache(source, coordinate):
    with open_sheet(source) as sheet:
        sheet[coordinate] = "=1+1"
        sheet.parent.save(source)
    output = source.parent / "out" / "越南马帮订单导入模板-VN261105-L.xlsx"
    output.parent.mkdir()
    output.write_bytes(b"existing output")
    with pytest.raises(OrderImportWorkbookError, match=rf"{coordinate}.*缓存.*重新计算"):
        generate(source)
    assert output.read_bytes() == b"existing output"
    assert list(output.parent.iterdir()) == [output]


@pytest.fixture
def sheet():
    workbook = Workbook()
    yield workbook.active
    workbook.close()


@pytest.mark.parametrize("country", ["brazil", "vietnam"])
@pytest.mark.parametrize(("today", "near", "distant", "expected"), [
    (date(2028, 1, 1), "1/1", "7/2", date(2028, 1, 1)),
    (date(2026, 11, 4), "11/4", "2/29", date(2026, 11, 4)),
    (TODAY, "11/6", "11/3", date(2026, 11, 6)),
])
def test_date_candidates(sheet, country, today, near, distant, expected):
    if country == "brazil":
        for column in range(46, 57):
            sheet.cell(1, column, f"{distant}海运")
        winner, far, mode, column = "AT", "AU", "海运", 46
    else:
        winner, far, mode, column = "AQ", "AO", "海运", 43
        sheet[f"{far}1"] = f"{distant}陆运"
    sheet[f"{winner}1"] = f"{near}{mode}"
    sheet[f"{far}1"].fill = PatternFill(fill_type="solid", fgColor="FFFFFF00")
    wanted = country_rules.ShippingCandidate(column, f"{near}{mode}", expected, mode)
    for override in (None, winner):
        assert country_rules.select_shipping_columns(
            country, sheet, today, shipping_column=override,
        )["selected"] == wanted


@pytest.mark.parametrize(("country", "today", "left", "right", "expected"), [
    ("brazil", date(2026, 8, 24), "8/24A海运", "8/24B海运", date(2026, 8, 24)),
    ("brazil", date(2027, 1, 1), "12/31海运", "1/2海运", date(2027, 1, 2)),
    ("vietnam", date(2028, 1, 1), "12/31陆运", "1/2海运", date(2028, 1, 2)),
])
def test_ties(sheet, country, today, left, right, expected):
    if country == "brazil":
        for column in range(46, 57):
            sheet.cell(1, column, "10/1海运")
        a, b, column = "AW", "AX", 50
    else:
        a, b, column = "AO", "AQ", 43
        sheet["AR1"] = "7/2海运"
    sheet[f"{a}1"], sheet[f"{b}1"] = left, right
    sheet[f"{a}1"].fill = PatternFill(fill_type="solid", fgColor="FFFFFF00")
    with pytest.raises(OrderImportWorkbookError, match=rf"并列.*{a}.*{b}"):
        country_rules.select_shipping_columns(country, sheet, today)
    wanted = country_rules.ShippingCandidate(column, right, expected, "海运")
    assert country_rules.select_shipping_columns(country, sheet, today, shipping_column=b)["selected"] == wanted
    with pytest.raises(OrderImportWorkbookError, match="不是最近日期"):
        country_rules.select_shipping_columns(
            country, sheet, today, shipping_column="AT" if country == "brazil" else "AR",
        )


@pytest.mark.parametrize(("today", "expected"), [
    (date(2026, 1, 1), date(2024, 2, 29)), (date(2026, 11, 4), date(2028, 2, 29)),
    (date(2100, 2, 28), date(2096, 2, 29)), (date(2100, 3, 1), date(2104, 2, 29)),
])
def test_leap_year(today, expected):
    assert nearest_occurrence(2, 29, today, country="越南", label="AQ1") == expected


def test_winning_year_tie(sheet):
    sheet["AQ1"] = "7/2海运"
    for override in (None, "AQ"):
        with pytest.raises(OrderImportWorkbookError, match="AQ1.*7/2海运.*无法确定年份"):
            country_rules.select_shipping_columns("vietnam", sheet, date(2028, 1, 1), shipping_column=override)


@pytest.mark.parametrize("header", ["2/30海运", "4/31海运", "13/1海运"])
def test_invalid_date(sheet, header):
    sheet["AO1"], sheet["AQ1"] = "11/4陆运", header
    with pytest.raises(OrderImportWorkbookError, match="日期表头无效.*AQ1"):
        country_rules.select_shipping_columns("vietnam", sheet, TODAY)


def test_philippines_selects_each_transport_across_year_boundary(sheet):
    sheet["AO1"], sheet["AP1"] = "12/31空运", "1/3空运"
    sheet["AY1"], sheet["AZ1"] = "1/2A海运", "12/30B海运"
    selected = country_rules.select_shipping_columns("philippines", sheet, date(2027, 1, 1))
    assert selected == {
        "air": country_rules.ShippingCandidate(41, "12/31空运", date(2026, 12, 31), "air"),
        "sea_a": country_rules.ShippingCandidate(51, "1/2A海运", date(2027, 1, 2), "sea_a"),
        "sea_b": country_rules.ShippingCandidate(52, "12/30B海运", date(2026, 12, 30), "sea_b"),
    }


def test_philippines_rechecks_only_selected_year_tie(sheet):
    sheet["AO1"], sheet["AP1"] = "1/1空运", "7/2空运"
    sheet["AY1"], sheet["AZ1"] = "1/1A海运", "1/1B海运"
    selected = country_rules.select_shipping_columns("philippines", sheet, date(2028, 1, 1))
    assert selected["air"].column == 41
    sheet["AO1"] = None
    with pytest.raises(OrderImportWorkbookError, match="AP1.*7/2空运.*无法确定年份"):
        country_rules.select_shipping_columns("philippines", sheet, date(2028, 1, 1))
