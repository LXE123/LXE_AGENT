from datetime import date
from pathlib import Path

import pytest
from openpyxl import Workbook
from openpyxl.styles import Color, PatternFill

from services.mabang.order_import import country_rules
from order_import_test_helpers import TEMPLATE, open_sheet


TODAY = date(2026, 11, 5)
YELLOW = PatternFill(fill_type="solid", fgColor="FFFFFF00")


@pytest.mark.parametrize("country", ["brazil", "malaysia", "vietnam", "philippines", "indonesia"])
def test_closest_date_and_yellow_batches_apply_to_every_country(country):
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
        "sea": "11/5海运", "sea_a": "11/5A海运", "sea_b": "11/4B海运", "air": "11/5空运",
    }
    workbook.close()


def test_closer_date_wins_over_a_later_date_without_yellow():
    workbook = Workbook()
    sheet = workbook.active
    sheet["A1"], sheet["B1"] = "11/4空运", "11/20空运"

    selected = country_rules.select_shipping_columns("indonesia", sheet, TODAY)

    assert selected["air"].header == "11/4空运"
    workbook.close()


def test_yellow_batch_selects_its_closest_date_even_when_that_column_is_not_yellow():
    workbook = Workbook()
    sheet = workbook.active
    sheet["A1"], sheet["B1"], sheet["C1"] = "11/5海运", "11/3A海运", "11/4A海运"
    sheet["B1"].fill = YELLOW

    selected = country_rules.select_shipping_columns("indonesia", sheet, TODAY)

    assert {field: item.header for field, item in selected.items()} == {
        "sea": "11/5海运", "sea_a": "11/4A海运",
    }
    workbook.close()


def test_equal_distance_for_one_batch_selects_the_later_date():
    workbook = Workbook()
    sheet = workbook.active
    sheet["A1"], sheet["B1"] = "11/4A海运", "11/6A海运"
    sheet["A1"].fill = sheet["B1"].fill = YELLOW

    selected = country_rules.select_shipping_columns("indonesia", sheet, TODAY)

    assert selected["sea_a"].header == "11/6A海运"
    workbook.close()


def test_equally_close_dates_in_different_batches_are_both_selected():
    workbook = Workbook()
    sheet = workbook.active
    sheet["A1"], sheet["B1"] = "11/4A海运", "11/6B海运"

    selected = country_rules.select_shipping_columns("indonesia", sheet, TODAY)

    assert {field: item.header for field, item in selected.items()} == {
        "sea_a": "11/4A海运", "sea_b": "11/6B海运",
    }
    workbook.close()


def test_indexed_yellow_is_selected_but_a_green_theme_is_not():
    workbook = Workbook()
    sheet = workbook.active
    sheet["A1"], sheet["B1"], sheet["C1"] = "11/5海运", "11/4A海运", "11/3B海运"
    sheet["B1"].fill = PatternFill(fill_type="solid", fgColor=Color(indexed=5))
    sheet["C1"].fill = PatternFill(fill_type="solid", fgColor=Color(theme=7))

    selected = country_rules.select_shipping_columns("indonesia", sheet, TODAY)

    assert {field: item.header for field, item in selected.items()} == {
        "sea": "11/5海运", "sea_a": "11/4A海运",
    }
    workbook.close()


def test_xlsx_output_uses_nearest_and_yellow_columns_without_collisions(tmp_path):
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "印尼"
    sheet["E1"], sheet["E2"] = "SKU", "SKU-A"
    for column, header, quantity, yellow in [
        ("BH", "11/5海运", 2, False), ("BI", "11/3A海运", 3, True),
        ("BJ", "11/4B海运", 4, True), ("BK", "11/5A海运", 5, False),
    ]:
        sheet[f"{column}1"], sheet[f"{column}2"] = header, quantity
        if yellow:
            sheet[f"{column}1"].fill = YELLOW
    source = tmp_path / "source.xlsx"
    workbook.save(source)
    workbook.close()

    artifacts = country_rules.generate_order_workbooks(
        "indonesia", source, tmp_path / "output", today=TODAY, template_path=TEMPLATE,
    )

    assert {item["order_id"]: item["shipping_header"] for item in artifacts} == {
        "IN261105-H": "11/5海运", "IN261105A-H": "11/5A海运", "IN261105B-H": "11/4B海运",
    }
    assert len({item["output_xlsx"] for item in artifacts}) == 3
    for artifact in artifacts:
        with open_sheet(Path(artifact["output_xlsx"])) as output:
            assert output["T2"].value == {"IN261105-H": 2, "IN261105A-H": 5, "IN261105B-H": 4}[
                artifact["order_id"]
            ]
