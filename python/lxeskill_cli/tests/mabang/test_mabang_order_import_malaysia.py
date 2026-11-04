from __future__ import annotations

from datetime import date, datetime
import json
from pathlib import Path

import pytest
from openpyxl import Workbook, load_workbook
from openpyxl.styles import PatternFill

from lxeskill import cli
from services.mabang.order_import.malaysia import (
    OrderImportWorkbookError,
    generate_order_workbooks,
)


TEMPLATE = Path(__file__).resolve().parents[2] / "services/mabang/order_import/resources/template.xlsx"


def malaysia_source(path: Path) -> None:
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "马来西亚"
    sheet["E1"] = "SKU"
    headers = {
        2: "11/4A海运",
        7: "11/4B海运",
        8: "11/4空运",
        44: "10/30空运",
        50: "10/15A海运",
        51: "10/15B海运",
    }
    for column, value in headers.items():
        sheet.cell(1, column, value)
    sheet["AR1"].fill = PatternFill(fill_type="solid", fgColor="FFFFFF00")
    for row, sku in ((2, "SKU-A"), (3, "SKU-B"), (4, "SKU-A")):
        sheet.cell(row, 5, sku)
    sheet["B2"] = 7
    sheet["G2"] = 0
    sheet["H2"] = 5
    sheet["B3"] = 0
    sheet["G3"] = None
    sheet["H3"] = None
    sheet["B4"] = None
    sheet["G4"] = 9
    sheet["H4"] = 3
    # A left-of-SKU quantity column must not read an unrelated cell via a negative index.
    sheet["F2"] = 999
    # An unused historical column must not block this export.
    sheet["AR2"] = "=1+1"
    workbook.save(path)
    workbook.close()


@pytest.fixture
def malaysia_cli_source(monkeypatch, tmp_path):
    class FixedDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            return cls(2026, 11, 5, tzinfo=tz)

    source = tmp_path / "source.xlsx"
    malaysia_source(source)
    monkeypatch.setattr("services.mabang.order_import.workflow.datetime", FixedDatetime)
    monkeypatch.delenv("LXESKILL_SKILL_SCOPE", raising=False)
    monkeypatch.setenv("LXE_WORKSPACE_ROOT", str(tmp_path))
    monkeypatch.setenv("LXE_DATA_ROOT", str(tmp_path / "state"))
    return source


def test_cli_generates_latest_group_with_correct_columns_and_three_complete_files(malaysia_cli_source, capsys):
    source_before = malaysia_cli_source.read_bytes()
    assert cli.main([
        "mabang", "order-import", "generate", "--country", "malaysia", "--input-xlsx", str(malaysia_cli_source)
    ]) == 0
    result = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert result["ok"] is True
    assert result["data"]["success"] is True
    assert result["data"]["status"] == "completed"
    assert result["data"]["country"] == "malaysia"
    assert result["data"]["sku_count"] == 3
    assert result["data"]["order_ids"] == ["MY261105A-H", "MY261105B-H", "MY261105-K"]
    artifacts = result["data"]["artifacts"]
    assert len(artifacts) == 3
    assert len(result["files"]) == 3
    assert set(result["files"]) == {item["path"] for item in artifacts}
    assert all(Path(path).is_file() for path in result["files"])

    assert [(item["order_id"], item["shipping_header"], item["sku_count"]) for item in artifacts] == [
        ("MY261105A-H", "11/4A海运", 3),
        ("MY261105B-H", "11/4B海运", 3),
        ("MY261105-K", "11/4空运", 3),
    ]
    assert [(item["shipping_column"], item["shipping_date"]) for item in artifacts] == [
        (2, "2026-11-04"), (7, "2026-11-04"), (8, "2026-11-04"),
    ]
    assert [Path(item["path"]).name for item in artifacts] == [
        "马来西亚马帮订单导入模板-MY261105A-H.xlsx",
        "马来西亚马帮订单导入模板-MY261105B-H.xlsx",
        "马来西亚马帮订单导入模板-MY261105-K.xlsx",
    ]
    expected_quantities = {
        "MY261105A-H": [7, None, None],
        "MY261105B-H": [None, None, 9],
        "MY261105-K": [5, None, 3],
    }
    for artifact in artifacts:
        workbook = load_workbook(artifact["path"], data_only=False)
        try:
            sheet = workbook["订单标准模板"]
            assert sheet.max_row == 4
            assert sheet.auto_filter.ref == "A1:AE4"
            assert [sheet.cell(row, 4).value for row in range(2, 5)] == ["SKU-A", "SKU-B", "SKU-A"]
            assert [sheet.cell(row, 20).value for row in range(2, 5)] == expected_quantities[artifact["order_id"]]
            assert [(sheet.cell(row, 1).value, sheet.cell(row, 2).value) for row in range(2, 5)] == [
                (artifact["order_id"], artifact["order_id"]),
            ] * 3
            assert sheet["E2"].value == "SHEN"
            assert sheet["F2"].value == "深圳"
        finally:
            workbook.close()
    assert malaysia_cli_source.read_bytes() == source_before


def test_cli_rejects_invalid_quantity_without_deliverables(malaysia_cli_source, capsys):
    workbook = load_workbook(malaysia_cli_source)
    workbook["马来西亚"]["G2"] = "#VALUE!"
    workbook.save(malaysia_cli_source)
    workbook.close()
    source_before = malaysia_cli_source.read_bytes()

    assert cli.main([
        "mabang", "order-import", "generate", "--country", "malaysia", "--input-xlsx", str(malaysia_cli_source)
    ]) != 0

    result = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert result["ok"] is False
    assert result["files"] == []
    assert "G2" in result["error"]["message"]
    assert "#VALUE!" in result["error"]["message"]
    assert "validation" not in result["data"]
    assert list(malaysia_cli_source.parent.rglob("*.xlsx")) == [malaysia_cli_source]
    assert malaysia_cli_source.read_bytes() == source_before


def test_cli_removes_first_workbook_when_second_write_fails(malaysia_cli_source, monkeypatch, capsys):
    from services.mabang.order_import import malaysia

    original_writer = malaysia.generate_order_workbook
    attempted_outputs = []

    def fail_second_write(rows, output_xlsx, **kwargs):
        attempted_outputs.append(Path(output_xlsx))
        if len(attempted_outputs) == 2:
            assert attempted_outputs[0].is_file()
            raise OSError("second workbook write failed")
        return original_writer(rows, output_xlsx, **kwargs)

    monkeypatch.setattr(malaysia, "generate_order_workbook", fail_second_write)
    source_before = malaysia_cli_source.read_bytes()

    assert cli.main([
        "mabang", "order-import", "generate", "--country", "malaysia", "--input-xlsx", str(malaysia_cli_source)
    ]) != 0

    result = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert result["ok"] is False
    assert result["files"] == []
    assert result["error"]["message"] == "second workbook write failed"
    assert "validation" not in result["data"]
    assert [path.name for path in attempted_outputs] == [
        "马来西亚马帮订单导入模板-MY261105A-H.xlsx",
        "马来西亚马帮订单导入模板-MY261105B-H.xlsx",
    ]
    assert not attempted_outputs[0].parent.exists()
    assert list(malaysia_cli_source.parent.rglob("*.xlsx")) == [malaysia_cli_source]
    assert malaysia_cli_source.read_bytes() == source_before


def test_newest_incomplete_group_fails_instead_of_falling_back(tmp_path):
    source = tmp_path / "source.xlsx"
    malaysia_source(source)
    workbook = load_workbook(source)
    workbook["马来西亚"]["BB1"] = "11/5A海运"
    workbook.save(source)
    workbook.close()

    with pytest.raises(OrderImportWorkbookError, match="最新日期组 2026-11-05 缺少字段.*B海运.*空运"):
        generate_order_workbooks(source, tmp_path / "out", today=date(2026, 11, 5), template_path=TEMPLATE)
    assert not list((tmp_path / "out").glob("*.xlsx"))


def test_uncached_selected_quantity_formula_reports_cell(tmp_path):
    source = tmp_path / "source.xlsx"
    malaysia_source(source)
    workbook = load_workbook(source)
    workbook["马来西亚"]["B2"] = "=10+20"
    workbook.save(source)
    workbook.close()

    with pytest.raises(OrderImportWorkbookError, match="B2.*公式没有缓存结果"):
        generate_order_workbooks(source, tmp_path / "out", today=date(2026, 11, 5), template_path=TEMPLATE)
    assert not list((tmp_path / "out").glob("*.xlsx"))


def test_command_requires_country_and_rejects_malaysia_shipping_override():
    from services.commands.mabang import order_import_generate as command

    assert command.run({"input_xlsx": "source.xlsx"})["error"]["code"] == "invalid_arguments"
    result = command.run({
        "country": "malaysia",
        "input_xlsx": "source.xlsx",
        "shipping_column": "BD",
    })
    assert result["error"]["code"] == "invalid_arguments"
