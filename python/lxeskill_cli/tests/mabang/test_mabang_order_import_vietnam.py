from __future__ import annotations

from datetime import date, datetime
import json
from pathlib import Path

import pytest
from openpyxl import Workbook, load_workbook
from openpyxl.styles import PatternFill

from lxeskill import cli
from services.mabang.order_import.source import parse_quantity
from services.mabang.order_import.vietnam import select_shipping_column
from services.mabang.order_import.workbook import OrderImportWorkbookError
from services.mabang.order_import.workflow import run


def vietnam_source(path: Path, *, sea_header: str = "10/30海运", quantity=5) -> None:
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "越南备货清单"
    sheet["E1"] = "SKU"
    sheet["AO1"] = "11/4陆运"
    sheet["AQ1"] = sea_header
    for row, sku, land_quantity, sea_quantity in (
        (2, "SKU-A", quantity, 3),
        (3, "SKU-B", 0, 4),
        (4, "SKU-A", None, None),
    ):
        sheet.cell(row, 5, sku)
        sheet.cell(row, 41, land_quantity)
        sheet.cell(row, 43, sea_quantity)
    workbook.save(path)
    workbook.close()


@pytest.fixture
def cli_environment(tmp_path, monkeypatch):
    class FixedDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            return cls(2026, 11, 5, tzinfo=tz)

    monkeypatch.setattr("services.mabang.order_import.workflow.datetime", FixedDatetime)
    monkeypatch.delenv("LXESKILL_SKILL_SCOPE", raising=False)
    monkeypatch.setenv("LXE_WORKSPACE_ROOT", str(tmp_path))
    monkeypatch.setenv("LXE_DATA_ROOT", str(tmp_path / "state"))


def test_nearest_shipping_column_uses_all_dates_and_ignores_fill():
    workbook = Workbook()
    sheet = workbook.active
    sheet["AO1"] = "11/3陆运"
    sheet["AQ1"] = "11/6海运"
    sheet["AQ1"].fill = PatternFill(fill_type="solid", fgColor="FFFFFF00")

    selected = select_shipping_column(sheet, date(2026, 11, 5))

    assert selected == (43, "11/6海运", date(2026, 11, 6), "海运")
    workbook.close()


def test_nearest_date_tie_requires_selected_candidate_column():
    workbook = Workbook()
    sheet = workbook.active
    sheet["AO1"] = "11/4陆运"
    sheet["AQ1"] = "11/6海运"

    with pytest.raises(OrderImportWorkbookError, match="最近运输日期并列.*AO.*AQ"):
        select_shipping_column(sheet, date(2026, 11, 5))

    assert select_shipping_column(sheet, date(2026, 11, 5), "AQ")[3] == "海运"
    workbook.close()


@pytest.mark.parametrize(
    ("sea_header", "shipping_column", "order_id", "shipping", "quantities"),
    [
        ("10/30海运", None, "VN261105-L", (41, "11/4陆运", "2026-11-04", "陆运"), [5, None, None]),
        ("11/6海运", "AQ", "VN261105-H", (43, "11/6海运", "2026-11-06", "海运"), [3, 4, None]),
    ],
)
def test_cli_generates_selected_transport_and_preserves_rows(
    tmp_path, cli_environment, capsys, sea_header, shipping_column, order_id, shipping, quantities
):
    source = tmp_path / "vietnam.xlsx"
    vietnam_source(source, sea_header=sea_header)
    arguments = ["mabang", "order-import", "generate", "--country", "vietnam", "--input-xlsx", str(source)]
    if shipping_column:
        arguments.extend(["--shipping-column", shipping_column])

    assert cli.main(arguments) == 0
    result = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert result["ok"] is True
    assert result["data"]["country"] == "vietnam"
    assert result["data"]["order_ids"] == [order_id]
    assert len(result["data"]["artifacts"]) == 1
    artifact = result["data"]["artifacts"][0]
    assert artifact["order_id"] == order_id
    assert tuple(artifact[key] for key in ("shipping_column", "shipping_header", "shipping_date", "shipping_mode")) == shipping
    assert artifact["sku_count"] == 3
    assert artifact["quantity_value_count"] == sum(quantity is not None for quantity in quantities)
    assert len(result["files"]) == 1
    output = Path(result["files"][0])
    assert output.name == f"越南马帮订单导入模板-{order_id}.xlsx"
    assert output.is_file()
    generated = load_workbook(output, data_only=False)
    try:
        sheet = generated["订单标准模板"]
        assert [sheet.cell(row, 4).value for row in range(2, 5)] == ["SKU-A", "SKU-B", "SKU-A"]
        assert [sheet.cell(row, 20).value for row in range(2, 5)] == quantities
        assert [(sheet.cell(row, 1).value, sheet.cell(row, 2).value) for row in range(2, 5)] == [
            (order_id, order_id)
        ] * 3
        assert sheet["S2"].value == 0
        assert sheet.auto_filter.ref == "A1:AE4"
    finally:
        generated.close()


@pytest.mark.parametrize("invalid_quantity", [-1, "bad", True, "NaN"])
def test_quantity_parser_rejects_invalid_values(invalid_quantity):
    with pytest.raises(OrderImportWorkbookError, match="AO2.*数量"):
        parse_quantity(invalid_quantity, coordinate="AO2", country="越南")


@pytest.mark.parametrize(
    ("quantity", "error_text"),
    [("=2+3", "公式没有缓存结果"), ("bad", "数量无效")],
)
def test_cli_rejects_invalid_quantity_without_deliverables(tmp_path, cli_environment, capsys, quantity, error_text):
    source = tmp_path / "vietnam.xlsx"
    vietnam_source(source, quantity=quantity)

    assert cli.main([
        "mabang", "order-import", "generate", "--country", "vietnam", "--input-xlsx", str(source)
    ]) != 0
    result = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert result["ok"] is False
    assert result["files"] == []
    assert "AO2" in result["error"]["message"]
    assert error_text in result["error"]["message"]
    assert "validation" not in result["data"]
    assert list(tmp_path.rglob("*.xlsx")) == [source]


def test_malaysia_rejects_shipping_override():
    with pytest.raises(OrderImportWorkbookError, match="shipping_column 仅用于巴西或越南"):
        run(country="malaysia", input_xlsx="unused.xlsx", shipping_column="AO")
