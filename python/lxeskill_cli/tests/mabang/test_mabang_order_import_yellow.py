from datetime import date
from pathlib import Path

import pytest
from openpyxl import Workbook
from openpyxl.styles import Color, PatternFill

from services.mabang.order_import import country_rules
from order_import_test_helpers import TEMPLATE, open_sheet, rows


TODAY = date(2026, 11, 5)
YELLOW = PatternFill(fill_type="solid", fgColor="FFFFFF00")


@pytest.mark.parametrize("country", ["brazil", "malaysia", "vietnam", "philippines", "indonesia"])
def test_closest_date_ignores_older_yellow_batches_for_every_country(country):
    workbook = Workbook()
    sheet = workbook.active
    for coordinate, header in {
        "A1": "11/5海运", "B1": "11/3A海运", "C1": "11/5A海运",
        "D1": "11/4B海运", "E1": "11/5空运",
    }.items():
        sheet[coordinate] = header
    sheet["B1"].fill = YELLOW
    sheet["D1"].fill = YELLOW

    selected = country_rules.select_shipping_columns(country, sheet, TODAY)

    assert {field: item.header for field, item in selected.items()} == {
        "sea": "11/5海运", "sea_a": "11/5A海运", "air": "11/5空运",
    }
    sheet["A1"], sheet["B1"], sheet["C1"] = "1/1海运", "7/2A海运", "1/1A海运"
    sheet["D1"], sheet["E1"] = None, None
    selected = country_rules.select_shipping_columns(country, sheet, date(2028, 1, 1))
    assert {field: item.header for field, item in selected.items()} == {"sea": "1/1海运", "sea_a": "1/1A海运"}
    workbook.close()


def test_closer_date_wins_over_a_later_date_without_yellow():
    workbook = Workbook()
    sheet = workbook.active
    sheet["A1"], sheet["B1"] = "11/4空运", "11/20空运"

    selected = country_rules.select_shipping_columns("indonesia", sheet, TODAY)

    assert selected["air"].header == "11/4空运"
    workbook.close()


def test_older_yellow_batch_does_not_select_another_old_date():
    workbook = Workbook()
    sheet = workbook.active
    sheet["A1"], sheet["B1"], sheet["C1"] = "11/5海运", "11/3A海运", "11/4A海运"
    sheet["B1"].fill = YELLOW

    selected = country_rules.select_shipping_columns("indonesia", sheet, TODAY)

    assert {field: item.header for field, item in selected.items()} == {"sea": "11/5海运"}
    workbook.close()


def test_equal_distance_for_one_batch_selects_the_later_date():
    workbook = Workbook()
    sheet = workbook.active
    sheet["A1"], sheet["B1"] = "11/4A海运", "11/6A海运"
    sheet["A1"].fill = sheet["B1"].fill = YELLOW

    selected = country_rules.select_shipping_columns("indonesia", sheet, TODAY)

    assert selected["sea_a"].header == "11/6A海运"
    workbook.close()


def test_equally_close_dates_in_different_batches_choose_later_date():
    workbook = Workbook()
    sheet = workbook.active
    sheet["A1"], sheet["B1"] = "11/4A海运", "11/6B海运"

    selected = country_rules.select_shipping_columns("indonesia", sheet, TODAY)

    assert {field: item.header for field, item in selected.items()} == {"sea_b": "11/6B海运"}
    workbook.close()


def test_color_does_not_include_older_dates():
    workbook = Workbook()
    sheet = workbook.active
    sheet["A1"], sheet["B1"], sheet["C1"] = "11/5海运", "11/4A海运", "11/3B海运"
    sheet["B1"].fill = PatternFill(fill_type="solid", fgColor=Color(indexed=5))
    sheet["C1"].fill = PatternFill(fill_type="solid", fgColor=Color(theme=7))

    selected = country_rules.select_shipping_columns("indonesia", sheet, TODAY)

    assert {field: item.header for field, item in selected.items()} == {"sea": "11/5海运"}
    workbook.close()


def test_xlsx_output_uses_nearest_columns_across_year_boundary(tmp_path):
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "印尼"
    sheet["E1"], sheet["E2"], sheet["E3"], sheet["E4"] = "SKU", "SKU-A", "SKU-B", "SKU-C"
    sheet["BJ3"], sheet["BK3"], sheet["BH4"], sheet["BK4"] = 9, 0, 0, 10
    for column, header, quantity, yellow in [
        ("BH", "1/1海运", 2, False), ("BI", "7/2A海运", 3, True),
        ("BJ", "12/31B海运", 4, True), ("BK", "1/1A海运", 5, False),
        ("BL", "7/2海运", 99, False), ("BM", "1/1空运", 7, False), ("BN", "7/2空运", 99, False),
    ]:
        sheet[f"{column}1"], sheet[f"{column}2"] = header, quantity
        if yellow:
            sheet[f"{column}1"].fill = YELLOW
    source = tmp_path / "source.xlsx"
    workbook.save(source)
    workbook.close()

    artifacts = country_rules.generate_order_workbooks(
        "indonesia", source, tmp_path / "output", today=date(2028, 1, 1), template_path=TEMPLATE,
    )

    assert {item["order_id"]: item["shipping_header"] for item in artifacts} == {
        "IN280101-H": "1/1海运", "IN280101A-H": "1/1A海运",
        "IN280101-K": "1/1空运",
    }
    assert len({item["output_xlsx"] for item in artifacts}) == 3
    expected = {
        "IN280101-H": [("SKU-A", 0, 2)], "IN280101-K": [("SKU-A", 0, 7)],
        "IN280101A-H": [("SKU-A", 0, 5), ("SKU-C", 0, 10)],
    }
    for artifact in artifacts:
        assert artifact["shipping_date"] == "2028-01-01"
        with open_sheet(Path(artifact["output_xlsx"])) as output:
            assert rows(output) == expected[artifact["order_id"]]
            assert artifact["sku_count"] == artifact["quantity_value_count"] == len(expected[artifact["order_id"]])
            assert all(output.cell(i, 1).value == output.cell(i, 2).value == artifact["order_id"]
                       for i in range(2, output.max_row + 1))
