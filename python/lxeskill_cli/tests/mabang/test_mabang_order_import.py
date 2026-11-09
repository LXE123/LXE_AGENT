from datetime import datetime
import json
from pathlib import Path
import re

import pytest
from openpyxl.utils import get_column_letter

from lxeskill import cli
from lxeskill.business import load_catalog
from services.commands.mabang import order_import_generate as command
from services.mabang.order_import import country_rules, workflow
from services.mabang.order_import.workbook import OrderImportWorkbookError
from order_import_test_helpers import LAYOUTS, TEMPLATE, open_sheet, rows, source_workbook


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

    def run(country, changes=None, sheet_name=None, shipping_column=None, shipping_overrides=None):
        source = source_workbook(tmp_path / "source.xlsx", country, changes, sheet_name)
        original = source.read_bytes()
        args = ["mabang", "order-import", "generate", "--country", country, "--input-xlsx", str(source)]
        if shipping_column:
            args += ["--shipping-column", shipping_column]
        for mode, column in (shipping_overrides or {}).items():
            args += [f"--{mode.replace('_', '-')}-shipping-column", column]
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
    ("vietnam", None, {}, [("VN261105-L", 41, "11/4陆运", "2026-11-04", [5, None, None]),
                            ("VN261105-H", 43, "10/30海运", "2026-10-30", [3, 4, None])]),
    ("vietnam", "AQ", {"AQ1": "11/6海运"}, [("VN261105-L", 41, "11/4陆运", "2026-11-04", [5, None, None]),
                                               ("VN261105-H", 43, "11/6海运", "2026-11-06", [3, 4, None])]),
    ("philippines", None, {}, [
        ("PH261105-K", 41, "11/5空运", "2026-11-05", [10, None, None]),
        ("PH261105A-H", 51, "11/4A海运", "2026-11-04", [None, 8, None]),
    ]),
    ("indonesia", None, {}, [
        ("IN261105-K", 54, "11/6空运", "2026-11-06", [10, None, None]),
        ("IN261105-H", 59, "11/6海运", "2026-11-06", [None, 8, 4]),
    ]),
])
def test_cli_generates_country_artifacts(invoke, country, override, changes, expected):
    code, result, _ = invoke(country, changes, shipping_column=override)
    data = result["data"]
    assert code == 0 and result["ok"] and data["success"]
    assert (data["status"], data["country"], data["sku_count"]) == ("completed", country, 3)
    assert data["validation"]["status"] == "passed"
    assert data["order_ids"] == [item[0] for item in expected]
    assert result["files"] == [item["path"] for item in data["artifacts"]]
    if country == "philippines":
        assert [a["field"] for a in data["artifacts"]] == ["air", "sea_a"]
        assert [a["shipping_mode"] for a in data["artifacts"]] == ["空运", "A海运"]
    elif country == "indonesia":
        assert [a["field"] for a in data["artifacts"]] == ["air", "sea"]
        assert [a["shipping_mode"] for a in data["artifacts"]] == ["空运", "海运"]
    elif country == "malaysia":
        assert [a["field"] for a in data["artifacts"]] == ["sea_a", "sea_b", "air"]
        assert all("shipping_mode" not in a for a in data["artifacts"])
    elif country == "brazil":
        assert all("field" not in a and "shipping_mode" not in a for a in data["artifacts"])
    for artifact, (order_id, column, header, day, quantities) in zip(data["artifacts"], expected, strict=True):
        path = Path(artifact["path"])
        prefix = {"brazil": "巴西", "malaysia": "马来西亚", "vietnam": "越南", "philippines": "菲律宾", "indonesia": "印尼"}[country]
        filename = f"{prefix}马帮订单导入模板-{order_id}.xlsx"
        assert path.is_absolute() and path.name == filename
        assert tuple(artifact[key] for key in ("order_id", "shipping_column", "shipping_header", "shipping_date")) == (
            order_id, column, header, day)
        assert artifact["sku_count"] == 3
        assert artifact["quantity_value_count"] == sum(q is not None for q in quantities)
        if country == "vietnam":
            assert artifact["shipping_mode"] == ("陆运" if order_id.endswith("-L") else "海运")
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
    ("brazil", {"AX1": "8月24日海运"}, None, "AX1.*运输日期字段格式无效"),
    ("brazil", {"BD2": "=10+20"}, None, "BD2.*公式.*缓存.*重新计算"),
    ("malaysia", {"G2": "#VALUE!"}, None, "G2.*#VALUE!"),
    ("malaysia", {"BA1": "11/4A海运"}, None, "重复"),
    ("vietnam", {"AO2": "=2+3"}, None, "AO2.*公式没有缓存结果"),
    ("philippines", {}, "其他", "缺少必需工作表"),
    ("philippines", {"AY1": "2/30A海运"}, None, "日期表头无效.*AY1"),
    ("philippines", {"AO2": -1}, None, "AO2.*数量"),
    ("philippines", {"AO2": "=1+1"}, None, "AO2.*公式.*缓存"),
])
def test_cli_rejects_source_errors(invoke, country, changes, sheet_name, error):
    code, result, source = invoke(country, changes, sheet_name)
    assert code != 0 and result["ok"] is False and result["files"] == []
    assert re.search(error, result["error"]["message"])
    assert "validation" not in result["data"]
    assert list(source.parent.rglob("*.xlsx")) == [source]


def test_malaysia_rolls_back_partial_outputs(invoke, monkeypatch):
    writer = country_rules.generate_order_workbook
    attempted = []

    def fail_second(rows, output, **kwargs):
        attempted.append(Path(output))
        if len(attempted) == 2:
            assert attempted[0].is_file()
            raise OSError("second workbook write failed")
        return writer(rows, output, **kwargs)

    monkeypatch.setattr(country_rules, "generate_order_workbook", fail_second)
    code, result, source = invoke("malaysia")
    assert code != 0 and result["ok"] is False and result["files"] == []
    assert result["error"]["message"] == "second workbook write failed"
    assert "validation" not in result["data"]
    assert [p.name for p in attempted] == [f"马来西亚马帮订单导入模板-MY261105{batch}-H.xlsx" for batch in ("A", "B")]
    assert not attempted[0].parent.exists()
    assert list(source.parent.rglob("*.xlsx")) == [source]


def test_malaysia_chooses_closest_date_group_even_when_a_later_group_exists(invoke):
    changes = {
        "BA1": "11/20A海运", "BB1": "11/20B海运", "BC1": "11/20空运",
        "BA2": 11, "BB2": 22, "BC2": 33,
    }
    code, result, _ = invoke("malaysia", changes)
    assert code == 0 and result["ok"]
    artifacts = result["data"]["artifacts"]
    assert [a["field"] for a in artifacts] == ["sea_a", "sea_b", "air"]
    assert [a["shipping_column"] for a in artifacts] == [2, 7, 8]
    assert [a["shipping_date"] for a in artifacts] == ["2026-11-04"] * 3
    for artifact, quantity in zip(artifacts, [7, None, 5], strict=True):
        with open_sheet(artifact["path"]) as sheet:
            assert sheet["T2"].value == quantity


def test_brazil_cli_accepts_selected_duplicate_closest_candidate(invoke):
    changes = {"BC1": "11/6海运", "BC2": 19}
    code, result, source = invoke("brazil", changes)
    assert code != 0 and not result["ok"] and result["files"] == []
    assert re.search(r"重复.*BC.*BD", result["error"]["message"])
    assert list(source.parent.rglob("*.xlsx")) == [source]

    code, result, _ = invoke("brazil", changes, shipping_column="BC")
    assert code == 0 and result["ok"]
    artifact = result["data"]["artifacts"][0]
    assert artifact["shipping_column"] == "BC"
    with open_sheet(artifact["path"]) as sheet:
        assert sheet["T2"].value == 19


def test_philippines_duplicate_closest_columns_use_mode_specific_choices(invoke):
    changes = {
        "AO1": "11/6空运", "AP1": "11/6空运", "AP2": 11,
        "AY1": "11/6A海运", "BA1": "11/6A海运", "BA2": 22,
        "AZ1": "11/6B海运", "BB1": "11/6B海运", "BB2": 33,
    }
    code, result, source = invoke("philippines", changes)
    assert code != 0 and not result["ok"] and result["files"] == []
    assert re.search(r"空运.*重复.*AO.*AP", result["error"]["message"])
    assert list(source.parent.rglob("*.xlsx")) == [source]

    code, result, source = invoke("philippines", changes, shipping_overrides={"air": "AP"})
    assert code != 0 and not result["ok"] and result["files"] == []
    assert re.search(r"A海运.*重复.*AY.*BA", result["error"]["message"])
    assert list(source.parent.rglob("*.xlsx")) == [source]

    code, result, _ = invoke("philippines", changes, shipping_overrides={"air": "AP", "sea_a": "BA", "sea_b": "BB"})
    assert code == 0 and result["ok"]
    assert [a["shipping_column"] for a in result["data"]["artifacts"]] == [42, 53, 54]
    for artifact, quantity in zip(result["data"]["artifacts"], [11, 22, 33], strict=True):
        with open_sheet(artifact["path"]) as sheet:
            assert sheet["T2"].value == quantity


def test_philippines_rejects_override_outside_closest_candidates(invoke):
    code, result, source = invoke("philippines", shipping_overrides={"air": "AN"})
    assert code != 0 and not result["ok"] and result["files"] == []
    assert "最近" in result["error"]["message"]
    assert list(source.parent.rglob("*.xlsx")) == [source]


def test_philippines_keeps_all_skus_when_a_transport_has_no_quantity(invoke):
    code, result, _ = invoke("philippines", {"AO2": None, "AO3": 0, "AO4": None})
    assert code == 0 and result["ok"]
    air = result["data"]["artifacts"][0]
    assert air["sku_count"] == 3 and air["quantity_value_count"] == 0
    with open_sheet(air["path"]) as sheet:
        assert rows(sheet) == [("SKU-A", 0, None), ("SKU-B", 0, None), ("SKU-A", 0, None)]


@pytest.mark.parametrize(("changes", "expected"), [
    # Dates closer to today win over later dates.
    ({"BB1": "11/20空运", "BG1": "11/20海运", "BC1": "11/5A海运", "BD1": "11/5B海运"},
     [("air", "IN261105-K", 53, [None, None, None]), ("sea_a", "IN261105A-H", 55, [20, None, None]),
      ("sea_b", "IN261105B-H", 56, [None, 22, None])]),
    # Older ordinary sea columns do not compete with the closest A/B group.
    ({"BF1": "11/2海运", "BG1": "11/1海运", "BC1": "11/6A海运", "BD1": "11/6B海运"},
     [("air", "IN261105-K", 54, [10, None, None]), ("sea_a", "IN261105A-H", 55, [20, None, None]),
      ("sea_b", "IN261105B-H", 56, [None, 22, None])]),
    ({"BF1": "11/2海运", "BG1": "11/1海运", "BC1": "11/6A海运"},
     [("air", "IN261105-K", 54, [10, None, None]), ("sea_a", "IN261105A-H", 55, [20, None, None])]),
    ({"BF1": "11/2海运", "BG1": "11/1海运", "BD1": "11/6B海运"},
     [("air", "IN261105-K", 54, [10, None, None]), ("sea_b", "IN261105B-H", 56, [None, 22, None])]),
    # When the closest date has ordinary and both A/B, all three are exported.
    ({"BC1": "11/6A海运", "BD1": "11/6B海运"},
     [("air", "IN261105-K", 54, [10, None, None]), ("sea", "IN261105-H", 59, [None, 8, 4]),
      ("sea_a", "IN261105A-H", 55, [20, None, None]), ("sea_b", "IN261105B-H", 56, [None, 22, None])]),
    # Duplicated older columns have no bearing on the selected closest date.
    ({"BE1": "11/4海运"},
     [("air", "IN261105-K", 54, [10, None, None]), ("sea", "IN261105-H", 59, [None, 8, 4])]),
    # Even an entirely empty air shipment preserves every source SKU.
    ({"BB2": None, "BB3": 0, "BB4": None},
     [("air", "IN261105-K", 54, [None, None, None]), ("sea", "IN261105-H", 59, [None, 8, 4])]),
])
def test_indonesia_exports_all_modes_at_closest_sea_date(invoke, changes, expected):
    code, result, _ = invoke("indonesia", changes)
    assert code == 0 and result["ok"]
    artifacts = result["data"]["artifacts"]
    assert [(a["field"], a["order_id"], a["shipping_column"]) for a in artifacts] == [
        (field, order, column) for field, order, column, _ in expected]
    for artifact, (_, order, _, quantities) in zip(artifacts, expected, strict=True):
        assert Path(artifact["path"]).name == f"印尼马帮订单导入模板-{order}.xlsx"
        assert artifact["sku_count"] == 3
        with open_sheet(artifact["path"]) as sheet:
            assert rows(sheet) == list(zip(["SKU-A", "SKU-B", "SKU-A"], [0, 0, 0], quantities))


@pytest.mark.parametrize(("changes", "expected_id", "expected_column", "expected_quantities"), [
    ({"BA1": None, "BB1": None}, "IN261105-H", 59, [None, 8, 4]),
    ({"BC1": None, "BD1": None, "BE1": None, "BF1": None, "BG1": None},
     "IN261105-K", 54, [10, None, None]),
    ({"BA1": None, "BB1": None, "BC1": None, "BD1": None, "BE1": None, "BF1": None,
      "BG1": None, "BH1": "11/7陆运", "BH2": 17}, "IN261105-L", 60, [17, None, None]),
])
def test_indonesia_allows_one_transport_mode(invoke, changes, expected_id, expected_column, expected_quantities):
    code, result, _ = invoke("indonesia", changes)
    assert code == 0 and result["ok"]
    artifacts = result["data"]["artifacts"]
    assert len(artifacts) == 1
    assert (artifacts[0]["order_id"], artifacts[0]["shipping_column"]) == (expected_id, expected_column)
    assert Path(artifacts[0]["path"]).name == f"印尼马帮订单导入模板-{expected_id}.xlsx"
    with open_sheet(artifacts[0]["path"]) as sheet:
        assert rows(sheet) == list(zip(["SKU-A", "SKU-B", "SKU-A"], [0, 0, 0], expected_quantities))


def test_indonesia_each_transport_mode_selects_its_own_closest_date(invoke):
    changes = {"BB1": "11/10空运", "BG1": "11/15海运", "BH1": "11/20陆运", "BH2": 17}
    code, result, _ = invoke("indonesia", changes)
    assert code == 0 and result["ok"]
    artifacts = result["data"]["artifacts"]
    assert {a["order_id"]: (a["shipping_column"], a["shipping_date"]) for a in artifacts} == {
        "IN261105-K": (53, "2026-11-03"),
        "IN261105-H": (58, "2026-11-04"),
        "IN261105-L": (60, "2026-11-20"),
    }
    for artifact in artifacts:
        assert artifact["sku_count"] == 3
        with open_sheet(artifact["path"]) as sheet:
            assert [item[0] for item in rows(sheet)] == ["SKU-A", "SKU-B", "SKU-A"]


@pytest.mark.parametrize(("changes", "expected"), [
    # Every batch at one mode's closest date produces its own distinct order.
    ({"BG1": "11/5海运", "BC1": "11/5A海运", "BD1": "11/5B海运", "BH1": "11/5c海运", "BH2": 33},
     {"IN261105-H": 59, "IN261105A-H": 55, "IN261105B-H": 56, "IN261105C-H": 60}),
    # The closest sea batch may be D and may be the only batch on that date.
    ({"BH1": "11/5d海运", "BH2": 33}, {"IN261105D-H": 60}),
])
def test_indonesia_sea_batches_are_optional_and_case_normalized(invoke, changes, expected):
    code, result, _ = invoke("indonesia", changes)
    assert code == 0 and result["ok"]
    artifacts = result["data"]["artifacts"]
    sea = {a["order_id"]: a for a in artifacts if a["shipping_header"].endswith("海运")}
    assert {order: item["shipping_column"] for order, item in sea.items()} == expected
    assert len(artifacts) == len(expected) + 1  # the existing closest air column
    for order, artifact in sea.items():
        assert Path(artifact["path"]).name == f"印尼马帮订单导入模板-{order}.xlsx"
        assert artifact["sku_count"] == 3
        with open_sheet(artifact["path"]) as sheet:
            assert [item[0] for item in rows(sheet)] == ["SKU-A", "SKU-B", "SKU-A"]


def test_indonesia_batches_apply_to_air_and_land_as_well(invoke):
    changes = {"BH1": "11/5a空运", "BH2": 21, "BI1": "11/9b陆运", "BI2": 34}
    code, result, _ = invoke("indonesia", changes)
    assert code == 0 and result["ok"]
    artifacts = {a["order_id"]: a for a in result["data"]["artifacts"]}
    assert {order: item["shipping_column"] for order, item in artifacts.items()} == {
        "IN261105A-K": 60, "IN261105B-L": 61, "IN261105-H": 59,
    }
    for order, amount in (("IN261105A-K", 21), ("IN261105B-L", 34)):
        with open_sheet(artifacts[order]["path"]) as sheet:
            assert rows(sheet) == [("SKU-A", 0, amount), ("SKU-B", 0, None), ("SKU-A", 0, None)]


@pytest.mark.parametrize(("mode", "code", "field"), [
    ("陆运", "L", "land"), ("空运", "K", "air"), ("海运", "H", "sea"),
])
def test_indonesia_unbatched_and_abc_batches_are_distinct_for_each_mode(invoke, mode, code, field):
    changes = {f"{col}1": None for col in ("BA", "BB", "BC", "BD", "BE", "BF", "BG")}
    for column, batch, quantity in zip(("BA", "BB", "BC", "BD"), ("", "a", "B", "c"),
                                       (11, 22, 33, 44), strict=True):
        changes[f"{column}1"] = f"11/6{batch}{mode}"
        changes[f"{column}2"] = quantity
    result_code, result, _ = invoke("indonesia", changes)
    assert result_code == 0 and result["ok"]
    artifacts = {a["order_id"]: a for a in result["data"]["artifacts"]}
    assert set(artifacts) == {f"IN261105{batch}-{code}" for batch in ("", "A", "B", "C")}
    for batch, quantity in zip(("", "A", "B", "C"), (11, 22, 33, 44), strict=True):
        order = f"IN261105{batch}-{code}"
        artifact = artifacts[order]
        assert artifact["field"] == (f"{field}_{batch.lower()}" if batch else field)
        assert artifact["shipping_mode"] == f"{batch}{mode}"
        assert artifact["sku_count"] == 3
        with open_sheet(artifact["path"]) as sheet:
            assert rows(sheet)[0] == ("SKU-A", 0, quantity)
            assert [item[0] for item in rows(sheet)] == ["SKU-A", "SKU-B", "SKU-A"]


@pytest.mark.parametrize("header", ["海运/空运合计", "海运7/30天销量"])
def test_indonesia_ignores_non_date_headers(invoke, header):
    code, result, _ = invoke("indonesia", {"BH1": header})
    assert code == 0 and result["ok"]
    assert [(item["order_id"], item["shipping_column"]) for item in result["data"]["artifacts"]] == [
        ("IN261105-K", 54), ("IN261105-H", 59),
    ]


@pytest.mark.parametrize(("changes", "error"), [
    ({"BA1": None, "BB1": None, "BC1": None, "BD1": None, "BE1": None, "BF1": None,
      "BG1": None}, "运输|日期"),
    ({"BH1": "11/6空运"}, "重复|并列"),
    ({"BH1": "11/6海运"}, "重复|并列"),
    ({"BC1": "11/6a海运", "BH1": "11/6A海运"}, "重复|并列"),
    ({"BH1": "11/6AA海运"}, "BH1.*格式"),
    ({"BH1": "11月6日海运"}, "BH1.*格式"),
    ({"BH1": "11-6海运"}, "BH1.*格式"),
    ({"BH1": "2/30海运"}, "日期.*BH1"),
    ({"BG2": -1}, "BG2.*数量"),
])
def test_indonesia_rejects_unusable_selected_columns(invoke, changes, error):
    code, result, source = invoke("indonesia", changes)
    assert code != 0 and not result["ok"] and result["files"] == []
    assert re.search(error, result["error"]["message"])
    assert list(source.parent.rglob("*.xlsx")) == [source]


@pytest.mark.parametrize("failure", ["write", "final_check"])
def test_indonesia_cleans_all_files_on_partial_failure(invoke, monkeypatch, failure):
    produced = []
    if failure == "write":
        writer = country_rules.generate_order_workbook

        def fail_second(rows, output, **kwargs):
            produced.append(Path(output))
            if len(produced) == 2:
                assert produced[0].is_file()
                raise OSError("second workbook write failed")
            return writer(rows, output, **kwargs)

        monkeypatch.setattr(country_rules, "generate_order_workbook", fail_second)
    else:
        generate = country_rules.generate_order_workbooks

        def empty_second(*args, **kwargs):
            artifacts = generate(*args, **kwargs)
            produced.extend(Path(item["output_xlsx"]) for item in artifacts)
            assert len(produced) == 2 and all(path.is_file() for path in produced)
            produced[1].write_bytes(b"")
            return artifacts

        monkeypatch.setattr(country_rules, "generate_order_workbooks", empty_second)
    code, result, source = invoke("indonesia")
    assert code != 0 and not result["ok"] and result["files"] == []
    assert produced and not produced[0].parent.exists()
    assert list(source.parent.rglob("*.xlsx")) == [source]


def test_philippines_rolls_back_partial_outputs(invoke, monkeypatch):
    writer = country_rules.generate_order_workbook
    attempted = []

    def fail_second(rows, output, **kwargs):
        attempted.append(Path(output))
        if len(attempted) == 2:
            assert attempted[0].is_file()
            raise OSError("second workbook write failed")
        return writer(rows, output, **kwargs)

    monkeypatch.setattr(country_rules, "generate_order_workbook", fail_second)
    code, result, source = invoke("philippines")
    assert code != 0 and not result["ok"] and result["files"] == []
    assert result["error"]["message"] == "second workbook write failed"
    assert not attempted[0].parent.exists()
    assert list(source.parent.rglob("*.xlsx")) == [source]


def test_philippines_cleans_outputs_when_final_file_check_fails(invoke, monkeypatch):
    generate = country_rules.generate_order_workbooks
    produced = []

    def empty_second(*args, **kwargs):
        artifacts = generate(*args, **kwargs)
        produced.extend(Path(item["output_xlsx"]) for item in artifacts)
        assert len(produced) == 2 and all(path.is_file() for path in produced)
        produced[1].write_bytes(b"")
        return artifacts

    monkeypatch.setattr(country_rules, "generate_order_workbooks", empty_second)
    code, result, source = invoke("philippines")
    assert code != 0 and not result["ok"] and result["files"] == []
    assert "生成结果文件不存在或为空" in result["error"]["message"]
    assert not produced[0].parent.exists()
    assert list(source.parent.rglob("*.xlsx")) == [source]


@pytest.mark.parametrize("arguments", [{}, {"input_xlsx": "source.xlsx"},
    {"country": "brazil", "input_xlsx": "source.xlsx", "unknown": True},
    {"country": "malaysia", "input_xlsx": "source.xlsx", "shipping_column": "BD"},
    {"country": "malaysia", "input_xlsx": "source.xlsx", "air_shipping_column": "AO"},
    {"country": "philippines", "input_xlsx": "source.xlsx", "air_shipping_column": ""}])
def test_invalid_arguments(arguments):
    assert command.run(arguments)["error"]["code"] == "invalid_arguments"


def test_command_contract():
    entry = load_catalog()["mabang_order_import_generate"]
    assert entry["visibility"] == "business" and entry["exposed"] is True
    assert entry["command_path"] == ["mabang", "order-import", "generate"]
    assert entry["owner_skills"] == ["mabang-order-import-generate"]
    properties = entry["input_schema"]["properties"]
    assert {"philippines", "indonesia"} <= set(properties["country"]["enum"])
    assert {"air_shipping_column", "sea_a_shipping_column", "sea_b_shipping_column"} <= properties.keys()


def test_workflow_rejects_malaysia_override():
    with pytest.raises(OrderImportWorkbookError, match="shipping_column 仅用于巴西或越南"):
        workflow.run(country="malaysia", input_xlsx="unused.xlsx", shipping_column="AO")


def unified_headers(country, columns):
    changes = {f"{get_column_letter(column)}1": None for column in LAYOUTS[country][2]}
    for column, (header, quantity) in columns.items():
        changes[f"{column}1"] = header
        changes[f"{column}2"] = quantity
    return changes


@pytest.mark.parametrize(("country", "prefix"), [
    ("brazil", "BR"), ("malaysia", "MY"), ("vietnam", "VN"), ("philippines", "PH"),
])
def test_four_countries_export_each_transport_closest_date_and_all_batches(invoke, country, prefix):
    changes = unified_headers(country, {
        "BJ": ("11/1陆运", 1), "BK": ("11/6陆运", 2), "BL": ("11/6A陆运", 3),
        "BM": ("11/5空运", 4), "BN": ("11/7c空运", 5),
        "BO": ("11/8海运", 6), "BP": ("11/8B海运", 7),
    })
    code, result, _ = invoke(country, changes)
    assert code == 0 and result["ok"]
    artifacts = {item["order_id"]: item for item in result["data"]["artifacts"]}
    expected = {
        f"{prefix}261105-L": ("11/6陆运", 2), f"{prefix}261105A-L": ("11/6A陆运", 3),
        f"{prefix}261105-K": ("11/5空运", 4), f"{prefix}261105-H": ("11/8海运", 6),
        f"{prefix}261105B-H": ("11/8B海运", 7),
    }
    assert set(artifacts) == set(expected)
    for order, (header, quantity) in expected.items():
        assert artifacts[order]["shipping_header"] == header
        with open_sheet(artifacts[order]["path"]) as sheet:
            assert rows(sheet) == [("SKU-A", 0, quantity), ("SKU-B", 0, None), ("SKU-A", 0, None)]


@pytest.mark.parametrize(("country", "prefix", "mode", "suffix"), [
    ("brazil", "BR", "陆运", "L"), ("malaysia", "MY", "空运", "K"),
    ("vietnam", "VN", "海运", "H"), ("philippines", "PH", "陆运", "L"),
])
def test_four_countries_allow_a_single_transport(invoke, country, prefix, mode, suffix):
    changes = unified_headers(country, {"BJ": (f"11/6C{mode}", 8)})
    code, result, _ = invoke(country, changes)
    assert code == 0 and result["ok"]
    assert result["data"]["order_ids"] == [f"{prefix}261105C-{suffix}"]


@pytest.mark.parametrize("country", ["brazil", "vietnam", "philippines"])
def test_existing_overrides_resolve_duplicates_without_dropping_other_batches(invoke, country):
    changes = unified_headers(country, {
        "BJ": ("11/6空运", 1), "BK": ("11/6空运", 2),
        "BL": ("11/6A空运", 3), "BM": ("11/2空运", 4),
    })
    code, result, _ = invoke(country, changes)
    assert code != 0 and "重复" in result["error"]["message"]
    kwargs = {"shipping_overrides": {"air": "BK"}} if country == "philippines" else {"shipping_column": "BK"}
    code, result, _ = invoke(country, changes, **kwargs)
    assert code == 0 and result["ok"]
    assert {a["shipping_header"] for a in result["data"]["artifacts"]} == {"11/6空运", "11/6A空运"}
    chosen = next(a for a in result["data"]["artifacts"] if a["shipping_header"] == "11/6空运")
    with open_sheet(chosen["path"]) as sheet:
        assert sheet["T2"].value == 2
    kwargs = {"shipping_overrides": {"air": "BM"}} if country == "philippines" else {"shipping_column": "BM"}
    code, result, _ = invoke(country, changes, **kwargs)
    assert code != 0 and result["files"] == [] and "最近" in result["error"]["message"]


def test_philippines_override_rejects_a_different_batch(invoke):
    changes = unified_headers("philippines", {"BJ": ("11/6空运", 1), "BK": ("11/6A空运", 2)})
    code, result, _ = invoke("philippines", changes, shipping_overrides={"air": "BK"})
    assert code != 0 and result["files"] == [] and "最近" in result["error"]["message"]


@pytest.mark.parametrize("country", ["brazil", "malaysia", "vietnam", "philippines"])
@pytest.mark.parametrize("failure", ["write", "final_check"])
def test_four_countries_clean_partial_outputs(invoke, monkeypatch, country, failure):
    changes = unified_headers(country, {"BJ": ("11/6陆运", 1), "BK": ("11/6空运", 2)})
    produced = []
    if failure == "write":
        writer = country_rules.generate_order_workbook

        def fail_second(rows, output, **kwargs):
            produced.append(Path(output))
            if len(produced) == 2:
                raise OSError("second workbook write failed")
            return writer(rows, output, **kwargs)

        monkeypatch.setattr(country_rules, "generate_order_workbook", fail_second)
    else:
        generate = country_rules.generate_order_workbooks

        def empty_second(*args, **kwargs):
            artifacts = generate(*args, **kwargs)
            produced.extend(Path(item["output_xlsx"]) for item in artifacts)
            produced[1].write_bytes(b"")
            return artifacts

        monkeypatch.setattr(country_rules, "generate_order_workbooks", empty_second)
    code, result, source = invoke(country, changes)
    assert code != 0 and result["files"] == []
    assert produced and not produced[0].parent.exists()
    assert list(source.parent.rglob("*.xlsx")) == [source]
