from datetime import datetime
import json
from pathlib import Path
import re

import pytest

from lxeskill import cli
from lxeskill.business import load_catalog
from services.commands.mabang import order_import_generate as command
from services.mabang.order_import import malaysia, workflow
from services.mabang.order_import.workbook import OrderImportWorkbookError
from order_import_test_helpers import TEMPLATE, open_sheet, rows, source_workbook


@pytest.fixture
def invoke(tmp_path, monkeypatch, capsys):
    class FixedDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            return cls(2026, 11, 5, tzinfo=tz)

    monkeypatch.setattr(workflow, "datetime", FixedDatetime)
    monkeypatch.delenv("LXESKILL_SKILL_SCOPE", raising=False)
    monkeypatch.setenv("LXE_WORKSPACE_ROOT", str(tmp_path))
    monkeypatch.setenv("LXE_DATA_ROOT", str(tmp_path / "state"))

    def run(country, changes=None, sheet_name=None, shipping_column=None):
        source = source_workbook(tmp_path / "source.xlsx", country, changes, sheet_name)
        original = source.read_bytes()
        args = ["mabang", "order-import", "generate", "--country", country, "--input-xlsx", str(source)]
        if shipping_column:
            args += ["--shipping-column", shipping_column]
        code = cli.main(args)
        result = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
        assert source.read_bytes() == original
        return code, result, source

    return run


@pytest.mark.parametrize(("country", "override", "changes", "expected"), [
    ("brazil", None, {"F1": "sku"}, [("BR261105-H", "BD", "11/6海运", "2026-11-06", [10, None, 30])]),
    ("malaysia", None, {}, [
        ("MY261105A-H", 2, "11/4A海运", "2026-11-04", [7, None, None]),
        ("MY261105B-H", 7, "11/4B海运", "2026-11-04", [None, None, 9]),
        ("MY261105-K", 8, "11/4空运", "2026-11-04", [5, None, 3]),
    ]),
    ("vietnam", None, {}, [("VN261105-L", 41, "11/4陆运", "2026-11-04", [5, None, None])]),
    ("vietnam", "AQ", {"AQ1": "11/6海运"}, [("VN261105-H", 43, "11/6海运", "2026-11-06", [3, 4, None])]),
])
def test_cli_generates_country_artifacts(invoke, country, override, changes, expected):
    code, result, _ = invoke(country, changes, shipping_column=override)
    data = result["data"]
    assert code == 0 and result["ok"] and data["success"]
    assert (data["status"], data["country"], data["sku_count"]) == ("completed", country, 3)
    assert data["validation"]["status"] == "passed"
    assert data["order_ids"] == [item[0] for item in expected]
    assert result["files"] == [item["path"] for item in data["artifacts"]]
    prefix = {"brazil": "巴西", "malaysia": "马来西亚", "vietnam": "越南"}[country]
    for artifact, (order_id, column, header, day, quantities) in zip(data["artifacts"], expected, strict=True):
        path = Path(artifact["path"])
        assert path.is_absolute() and path.name == f"{prefix}马帮订单导入模板-{order_id}.xlsx"
        assert tuple(artifact[key] for key in ("order_id", "shipping_column", "shipping_header", "shipping_date")) == (
            order_id, column, header, day)
        assert artifact["sku_count"] == 3
        assert artifact["quantity_value_count"] == sum(q is not None for q in quantities)
        if country == "vietnam":
            assert artifact["shipping_mode"] == ("海运" if override else "陆运")
        with open_sheet(path) as sheet, open_sheet(TEMPLATE) as template:
            assert sheet.title == "订单标准模板"
            assert sheet.max_row == 4 and sheet.auto_filter.ref == "A1:AE4"
            assert rows(sheet) == list(zip(["SKU-A", "SKU-B", "SKU-A"], [0, 0, 0], quantities))
            assert [(sheet.cell(r, 1).value, sheet.cell(r, 2).value) for r in range(2, 5)] == [(order_id, order_id)] * 3
            assert [sheet[f"{c}2"].value for c in ("E", "F", "G", "J", "M")] == [
                "SHEN", "深圳", "中国", 111111, "深圳龙华"]
            assert all(sheet.cell(r, 4)._style == template["D2"]._style for r in range(2, 5))


@pytest.mark.parametrize(("country", "changes", "sheet_name", "error"), [
    ("brazil", {}, "其他", "缺少必需工作表"),
    ("brazil", {"F1": "库存SKU"}, None, "F1 必须是 SKU 表头"),
    ("brazil", {"AX1": "8月24日海运"}, None, "AX1.*表头缺失或格式无效"),
    ("brazil", {"BD2": "=10+20"}, None, "BD2.*公式.*缓存.*重新计算"),
    ("malaysia", {"G2": "#VALUE!"}, None, "G2.*#VALUE!"),
    ("malaysia", {"BB1": "11/5A海运"}, None, "2026-11-05 缺少字段: B海运, 空运"),
    ("malaysia", {"AR1": "2/29空运"}, None, "2028-02-29 缺少字段: A海运, B海运"),
    ("vietnam", {"AO2": "=2+3"}, None, "AO2.*公式没有缓存结果"),
])
def test_cli_rejects_source_errors(invoke, country, changes, sheet_name, error):
    code, result, source = invoke(country, changes, sheet_name)
    assert code != 0 and result["ok"] is False and result["files"] == []
    assert re.search(error, result["error"]["message"])
    assert "validation" not in result["data"]
    assert list(source.parent.rglob("*.xlsx")) == [source]


def test_malaysia_rolls_back_partial_outputs(invoke, monkeypatch):
    writer = malaysia.generate_order_workbook
    attempted = []

    def fail_second(rows, output, **kwargs):
        attempted.append(Path(output))
        if len(attempted) == 2:
            assert attempted[0].is_file()
            raise OSError("second workbook write failed")
        return writer(rows, output, **kwargs)

    monkeypatch.setattr(malaysia, "generate_order_workbook", fail_second)
    code, result, source = invoke("malaysia")
    assert code != 0 and result["ok"] is False and result["files"] == []
    assert result["error"]["message"] == "second workbook write failed"
    assert "validation" not in result["data"]
    assert [p.name for p in attempted] == [f"马来西亚马帮订单导入模板-MY261105{batch}-H.xlsx" for batch in ("A", "B")]
    assert not attempted[0].parent.exists()
    assert list(source.parent.rglob("*.xlsx")) == [source]


@pytest.mark.parametrize("arguments", [{}, {"input_xlsx": "source.xlsx"},
    {"country": "brazil", "input_xlsx": "source.xlsx", "unknown": True},
    {"country": "malaysia", "input_xlsx": "source.xlsx", "shipping_column": "BD"}])
def test_invalid_arguments(arguments):
    assert command.run(arguments)["error"]["code"] == "invalid_arguments"


def test_command_contract():
    entry = load_catalog()["mabang_order_import_generate"]
    assert entry["visibility"] == "business" and entry["exposed"] is True
    assert entry["command_path"] == ["mabang", "order-import", "generate"]
    assert entry["owner_skills"] == ["mabang-order-import-generate"]


def test_workflow_rejects_malaysia_override():
    with pytest.raises(OrderImportWorkbookError, match="shipping_column 仅用于巴西或越南"):
        workflow.run(country="malaysia", input_xlsx="unused.xlsx", shipping_column="AO")
