from __future__ import annotations

from datetime import date
from io import BytesIO
from pathlib import Path
from zipfile import ZipFile

import pytest
from openpyxl import Workbook, load_workbook
from openpyxl.styles import Color, PatternFill

from lxeskill import cli
from services.commands.mabang import brazil_order_import_generate as command
from services.mabang.brazil_order_import.workbook import (
    BrazilOrderWorkbookError,
    generate_order_workbook,
    select_shipping_column,
)


SEA_HEADERS = (
    "7/15海运", "7/29海运", "8/13海运", "8/24A海运", "8/24B海运", "9/8海运",
    "9/23海运", "10/13海运", "10/23海运", "10/30海运", "11/2海运",
)


def source_workbook(path: Path, *, sheet_name: str = "巴西", sku_header: str = "sku") -> None:
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = sheet_name
    sheet.cell(1, 6, sku_header)
    for column, header in enumerate(SEA_HEADERS, start=46):
        sheet.cell(1, column, header)
    sheet.cell(2, 6, "SKU-A")
    sheet.cell(2, 56, 10)
    sheet.cell(3, 6, "")
    sheet.cell(3, 56, 99)
    sheet.cell(4, 6, "SKU-B")
    sheet.cell(5, 6, "SKU-A")
    sheet.cell(5, 56, 30)
    workbook.save(path)
    workbook.close()


@pytest.fixture
def shipping_sheet():
    workbook = Workbook()
    sheet = workbook.active
    for column, header in enumerate(SEA_HEADERS, start=46):
        sheet.cell(1, column, header)
    yield sheet
    workbook.close()


def test_generator_rebuilds_rows_from_source_and_preserves_blank_quantity(tmp_path):
    source = tmp_path / "source.xlsx"
    output = tmp_path / "output.xlsx"
    source_workbook(source)

    result = generate_order_workbook(source, output, today=date(2026, 11, 3))

    check = load_workbook(output, data_only=False)
    sheet = check["订单标准模板"]
    assert sheet.max_row == 4  # Header plus 3 nonempty source SKUs, including the duplicate.
    assert sheet.auto_filter.ref == "A1:AE4"
    assert [sheet.cell(row, 4).value for row in (2, 3, 4)] == ["SKU-A", "SKU-B", "SKU-A"]
    assert [sheet.cell(row, 20).value for row in (2, 3, 4)] == [10, None, 30]
    assert [(sheet.cell(row, 1).value, sheet.cell(row, 2).value) for row in (2, 3, 4)] == [
        ("BR261103-H", "BR261103-H"),
    ] * 3
    assert sheet["E2"].value == "SHEN"
    assert sheet["F2"].value == "深圳"
    assert sheet["G2"].value == "中国"
    assert sheet["J2"].value == 111111
    assert sheet["M2"].value == "深圳龙华"
    assert sheet["S2"].value == 0
    assert sheet["D2"].style_id == sheet["D3"].style_id == sheet["D4"].style_id
    assert result["sku_count"] == 3
    assert result["quantity_value_count"] == 2
    assert result["shipping_column"] == "BD"
    assert result["shipping_header"] == "11/2海运"
    assert result["shipping_date"] == "2026-11-02"
    check.close()


@pytest.mark.parametrize("coordinate", ["F2", "BD2"])
def test_formula_without_cached_value_reports_cell_and_does_not_generate(tmp_path, coordinate):
    source = tmp_path / "source.xlsx"
    output = tmp_path / "output.xlsx"
    source_workbook(source)
    workbook = load_workbook(source)
    workbook["巴西"][coordinate] = '= "SKU-A"' if coordinate == "F2" else "=10+20"
    workbook.save(source)
    workbook.close()

    with pytest.raises(BrazilOrderWorkbookError, match=coordinate):
        generate_order_workbook(source, output, today=date(2026, 11, 3))
    assert not output.exists()


def test_cached_formula_and_literal_equals_sku_are_preserved(tmp_path):
    source = tmp_path / "source.xlsx"
    output = tmp_path / "output.xlsx"
    source_workbook(source)
    workbook = load_workbook(source)
    sheet = workbook["巴西"]
    sheet["F2"] = "=SKU-A"
    sheet["F2"].data_type = "s"
    sheet["BD2"] = "=10+20"
    workbook.save(source)
    workbook.close()

    # openpyxl does not calculate formulas: supply a numeric Excel-style cache.
    updated = BytesIO()
    with ZipFile(source) as original, ZipFile(updated, "w") as archive:
        for item in original.infolist():
            data = original.read(item.filename)
            if item.filename == "xl/worksheets/sheet1.xml":
                assert data.count(b"<f>10+20</f><v></v>") == 1
                data = data.replace(b"<f>10+20</f><v></v>", b"<f>10+20</f><v>30</v>")
            archive.writestr(item, data)
    source.write_bytes(updated.getvalue())

    generate_order_workbook(source, output, today=date(2026, 11, 3))
    result = load_workbook(output, data_only=True)
    assert result["订单标准模板"]["D2"].value == "=SKU-A"
    assert result["订单标准模板"]["T2"].value == 30
    assert result["订单标准模板"]["T3"].value is None
    result.close()


@pytest.mark.parametrize("fill", [None, PatternFill(fill_type="solid", fgColor="FFFFFF00"),
                                 PatternFill(fill_type="solid", fgColor=Color(indexed=13))])
def test_closest_date_wins_regardless_of_header_color(tmp_path, fill):
    source = tmp_path / "source.xlsx"
    output = tmp_path / "output.xlsx"
    source_workbook(source)
    workbook = load_workbook(source)
    sheet = workbook["巴西"]
    sheet["AT1"] = "11/19海运"
    sheet["AU1"] = "12/20海运"
    if fill:
        sheet["AT1"].fill = fill
        sheet["AU1"].fill = fill
    sheet["AT2"] = 88
    workbook.save(source)
    workbook.close()

    result = generate_order_workbook(source, output, today=date(2026, 11, 3))
    check = load_workbook(output, data_only=True)
    assert result["shipping_column"] == "BD"
    assert check["订单标准模板"]["T2"].value == 10
    check.close()


def test_shipping_date_tie_requires_explicit_nearest_column(shipping_sheet):
    with pytest.raises(BrazilOrderWorkbookError, match="最近海运日期并列.*AW.*AX"):
        select_shipping_column(shipping_sheet, date(2026, 8, 24))

    assert select_shipping_column(shipping_sheet, date(2026, 8, 24), "AX") == (
        "AX", "8/24B海运", date(2026, 8, 24)
    )
    with pytest.raises(BrazilOrderWorkbookError, match="不是最近日期列"):
        select_shipping_column(shipping_sheet, date(2026, 11, 3), "AX")


def test_closest_shipping_date_can_be_in_the_future(shipping_sheet):
    shipping_sheet["AT1"] = "11/4海运"
    shipping_sheet["BD1"] = "10/31海运"
    shipping_sheet["BD1"].fill = PatternFill(fill_type="solid", fgColor="FFFFFF00")

    assert select_shipping_column(shipping_sheet, date(2026, 11, 3)) == (
        "AT", "11/4海运", date(2026, 11, 4)
    )


def test_equal_distance_dates_require_choice_even_if_one_is_yellow(shipping_sheet):
    shipping_sheet["AW1"] = "11/2海运"
    shipping_sheet["AX1"] = "11/4海运"
    shipping_sheet["BD1"] = "10/30海运"
    yellow = PatternFill(fill_type="solid", fgColor="FFFFFF00")
    shipping_sheet["AW1"].fill = yellow

    with pytest.raises(BrazilOrderWorkbookError, match="最近海运日期并列.*AW.*AX"):
        select_shipping_column(shipping_sheet, date(2026, 11, 3))
    assert select_shipping_column(shipping_sheet, date(2026, 11, 3), "AX") == (
        "AX", "11/4海运", date(2026, 11, 4)
    )
    with pytest.raises(BrazilOrderWorkbookError, match="不是最近日期列"):
        select_shipping_column(shipping_sheet, date(2026, 11, 3), "AT")


def test_month_day_header_uses_nearest_year_across_new_year(shipping_sheet):
    headers = (
        "12/15海运", "12/20海运", "12/25海运", "12/30海运", "1/2海运", "1/5海运",
        "1/10海运", "2/1海运", "3/1海运", "4/1海运", "5/1海运",
    )
    for column, header in enumerate(headers, start=46):
        shipping_sheet.cell(1, column, header)

    assert select_shipping_column(shipping_sheet, date(2027, 1, 1)) == (
        "AX", "1/2海运", date(2027, 1, 2)
    )


@pytest.mark.parametrize(
    ("sheet_name", "sku_header", "expected_error"),
    [("其他", "sku", "缺少必需工作表"), ("巴西", "库存SKU", "F1 必须是 SKU 表头")],
)
def test_missing_required_source_contract_fails(tmp_path, sheet_name, sku_header, expected_error):
    source = tmp_path / "source.xlsx"
    source_workbook(source, sheet_name=sheet_name, sku_header=sku_header)
    with pytest.raises(BrazilOrderWorkbookError, match=expected_error):
        generate_order_workbook(source, tmp_path / "output.xlsx", today=date(2026, 11, 3))


def test_bad_shipping_header_fails_with_cell_reference(tmp_path):
    source = tmp_path / "source.xlsx"
    source_workbook(source)
    workbook = load_workbook(source)
    workbook["巴西"]["AX1"] = "8月24日海运"
    workbook.save(source)
    workbook.close()

    with pytest.raises(BrazilOrderWorkbookError, match="AX1.*表头缺失或格式无效"):
        generate_order_workbook(source, tmp_path / "output.xlsx", today=date(2026, 11, 3))


def test_command_validates_arguments_and_returns_generation_metadata(monkeypatch, tmp_path):
    output = tmp_path / "generated.xlsx"
    monkeypatch.setattr(
        command,
        "generate",
        lambda **kwargs: {
            "output_xlsx": output,
            "order_id": "BR261103-H",
            "sku_count": 2,
            "quantity_value_count": 1,
            "shipping_column": "BD",
            "shipping_header": "11/2海运",
            "shipping_date": "2026-11-02",
        },
    )
    output.touch()

    assert command.run({})["error"]["code"] == "invalid_arguments"
    assert command.run({"input_xlsx": "source.xlsx", "unknown": True})["error"]["code"] == "invalid_arguments"
    result = command.run({"input_xlsx": "source.xlsx", "shipping_column": "BD"})
    assert result["success"] is True
    assert result["order_id"] == "BR261103-H"
    assert result["output_xlsx"] == str(output.resolve())
    assert result["validation"]["status"] == "passed"


def test_catalog_cli_dispatches_module_with_flags(monkeypatch, capsys):
    calls = []
    monkeypatch.delenv("LXESKILL_SKILL_SCOPE", raising=False)

    def execute(entry, arguments, session, **kwargs):
        calls.append((entry["name"], arguments))
        return True, [{"text": "{}"}], [], None

    monkeypatch.setattr(cli, "execute_module_json", execute)
    assert cli.main([
        "mabang", "brazil", "order-import", "generate", "--input-xlsx", "source.xlsx",
        "--shipping-column", "BD",
    ]) == 0
    assert calls == [("mabang_brazil_order_import_generate", {"input_xlsx": "source.xlsx", "shipping_column": "BD"})]
    assert '"ok":true' in capsys.readouterr().out


def test_natural_language_skill_owns_public_command():
    from lxeskill.business import load_catalog
    from lxeskill.contract import validate_skill_command_contract

    catalog = load_catalog()
    entry = catalog["mabang_brazil_order_import_generate"]
    assert entry["visibility"] == "business"
    assert entry["exposed"] is True
    assert entry["owner_skills"] == ["mabang-brazil-order-import-generate"]

    project_root = Path(__file__).resolve().parents[4]
    report = validate_skill_command_contract(
        catalog,
        skills_root=project_root / "skills",
    )
    assert report.ok, [violation.code for violation in report.violations]
