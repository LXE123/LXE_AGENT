from datetime import date
from pathlib import Path

import pytest
from openpyxl import Workbook
from openpyxl.styles import Color, PatternFill
from openpyxl.utils import get_column_letter

from services.mabang.order_import import country_rules
from services.mabang.order_import.workbook import OrderImportWorkbookError
from order_import_test_helpers import LAYOUTS, TEMPLATE, open_sheet, rows, source_workbook


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
        "IN261105-H": "11/5海运", "IN261105A-H": "11/5A海运", "IN261104B-H": "11/4B海运",
    }
    assert len({item["output_xlsx"] for item in artifacts}) == 3
    for artifact in artifacts:
        with open_sheet(Path(artifact["output_xlsx"])) as output:
            assert output["T2"].value == {"IN261105-H": 2, "IN261105A-H": 5, "IN261104B-H": 4}[
                artifact["order_id"]
            ]


@pytest.mark.parametrize(("country", "prefix"), [
    ("brazil", "BR"), ("malaysia", "MY"), ("vietnam", "VN"),
    ("philippines", "PH"), ("indonesia", "IN"),
])
def test_selected_date_and_nonempty_quantities_determine_each_file(tmp_path, country, prefix):
    changes = {f"{get_column_letter(col)}1": None for col in LAYOUTS[country][2]}
    changes.update({"BJ1": "11/4海运", "BJ2": 10, "BJ3": None, "BJ4": 0,
                    "BK1": "11/3A海运", "BK2": None, "BK3": 25, "BK4": 30})
    source = source_workbook(tmp_path / "source.xlsx", country, changes)
    with open_sheet(source) as sheet:
        sheet["BK1"].fill = YELLOW
        sheet.parent.save(source)

    artifacts = country_rules.generate_order_workbooks(
        country, source, tmp_path / "output", today=TODAY, template_path=TEMPLATE,
    )

    expected = {
        f"{prefix}261104-H": ("11/4海运", [("SKU-A", 0, 10)]),
        f"{prefix}261103A-H": ("11/3A海运", [("SKU-B", 0, 25), ("SKU-A", 0, 30)]),
    }
    assert {item["order_id"] for item in artifacts} == set(expected)
    for artifact in artifacts:
        header, expected_rows = expected[artifact["order_id"]]
        assert artifact["shipping_header"] == header
        assert artifact["sku_count"] == artifact["quantity_value_count"] == len(expected_rows)
        with open_sheet(artifact["output_xlsx"]) as sheet:
            assert rows(sheet) == expected_rows
            assert [(sheet.cell(i, 1).value, sheet.cell(i, 2).value)
                    for i in range(2, sheet.max_row + 1)] == [(artifact["order_id"],) * 2] * len(expected_rows)


def test_order_date_uses_selected_year_across_new_year(tmp_path):
    changes = {f"{get_column_letter(col)}1": None for col in LAYOUTS["brazil"][2]}
    changes.update({"BJ1": "12/31海运", "BJ2": 10})
    source = source_workbook(tmp_path / "source.xlsx", "brazil", changes)

    artifacts = country_rules.generate_order_workbooks(
        "brazil", source, tmp_path / "output", today=date(2027, 1, 1), template_path=TEMPLATE,
    )

    assert [(item["order_id"], item["shipping_date"]) for item in artifacts] == [
        ("BR261231-H", "2026-12-31")
    ]


@pytest.mark.parametrize("country", ["brazil", "malaysia", "vietnam", "philippines", "indonesia"])
def test_unselected_ambiguous_yellow_column_does_not_block_closer_batch(country):
    workbook = Workbook()
    sheet = workbook.active
    sheet["A1"], sheet["B1"], sheet["C1"] = "1/1海运", "7/2A海运", "1/1A海运"
    sheet["B1"].fill = YELLOW

    selected = country_rules.select_shipping_columns(country, sheet, date(2028, 1, 1))

    assert {field: item.header for field, item in selected.items()} == {
        "sea": "1/1海运", "sea_a": "1/1A海运",
    }
    workbook.close()


def test_selected_yellow_column_with_ambiguous_year_still_fails():
    workbook = Workbook()
    sheet = workbook.active
    sheet["A1"], sheet["B1"] = "1/1海运", "7/2A海运"
    sheet["B1"].fill = YELLOW

    with pytest.raises(OrderImportWorkbookError, match="B1.*7/2A海运.*无法确定年份"):
        country_rules.select_shipping_columns("indonesia", sheet, date(2028, 1, 1))
    workbook.close()
