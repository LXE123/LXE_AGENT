from datetime import datetime
import json
from pathlib import Path
import re

import pytest
from openpyxl.styles import PatternFill
from openpyxl.utils import get_column_letter

from lxeskill import cli
from services.commands.mabang import order_import_generate as command
from services.mabang.order_import import workflow
from services.mabang.order_import.workbook import OrderImportWorkbookError
from order_import_test_helpers import LAYOUTS, TEMPLATE, interfere_with_publication, open_sheet, rows, source_workbook


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

    def run(country, changes=None, sheet_name=None, shipping_column=None, shipping_overrides=None, yellow_headers=()):
        source = source_workbook(tmp_path / "source.xlsx", country, changes, sheet_name)
        if yellow_headers:
            with open_sheet(source) as sheet:
                for coordinate in yellow_headers:
                    sheet[coordinate].fill = PatternFill(fill_type="solid", fgColor="FFFFFF00")
                sheet.parent.save(source)
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
    ("brazil", None, {"F1": "sku"}, [("BR261106-H", "BD", "11/6海运", "2026-11-06", [10, None, 30])]),
    ("malaysia", None, {}, [
        ("MY261104A-H", 2, "11/4A海运", "2026-11-04", [7, None, None]),
        ("MY261104B-H", 7, "11/4B海运", "2026-11-04", [None, None, 9]),
        ("MY261104-K", 8, "11/4空运", "2026-11-04", [5, None, 3]),
    ]),
    ("vietnam", None, {}, [("VN261104-L", 41, "11/4陆运", "2026-11-04", [5, None, None])]),
    ("vietnam", "AQ", {"AQ1": "11/6海运"}, [("VN261106-H", 43, "11/6海运", "2026-11-06", [3, 4, None])]),
    ("philippines", None, {}, [
        ("PH261105-K", 41, "11/5空运", "2026-11-05", [10, None, None]),
    ]),
    ("indonesia", None, {}, [
        ("IN261106-K", 54, "11/6空运", "2026-11-06", [10, None, None]),
        ("IN261106-H", 59, "11/6海运", "2026-11-06", [None, 8, 4]),
    ]),
])
def test_cli_generates_country_artifacts(invoke, country, override, changes, expected):
    code, result, _ = invoke(country, changes, shipping_column=override)
    data = result["data"]
    assert code == 0 and result["ok"] and data["success"]
    assert (data["status"], data["country"], data["sku_count"]) == (
        "completed", country, sum(q is not None for q in expected[0][4]))
    assert data["validation"]["status"] == "passed"
    assert data["order_ids"] == [item[0] for item in expected]
    assert result["files"] == [item["path"] for item in data["artifacts"]]
    if country == "philippines":
        assert [a["field"] for a in data["artifacts"]] == ["air"]
        assert [a["shipping_mode"] for a in data["artifacts"]] == ["空运"]
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
        expected_rows = [(sku, 0, q) for sku, q in zip(["SKU-A", "SKU-B", "SKU-A"], quantities) if q is not None]
        assert artifact["sku_count"] == len(expected_rows)
        assert artifact["quantity_value_count"] == sum(q is not None for q in quantities)
        if country == "vietnam":
            assert artifact["shipping_mode"] == ("陆运" if order_id.endswith("-L") else "海运")
        with open_sheet(path) as sheet, open_sheet(TEMPLATE) as template:
            assert sheet.title == "订单标准模板"
            assert sheet.max_row == len(expected_rows) + 1 and sheet.auto_filter.ref == f"A1:AE{len(expected_rows) + 1}"
            assert rows(sheet) == expected_rows
            assert [(sheet.cell(r, 1).value, sheet.cell(r, 2).value) for r in range(2, sheet.max_row + 1)] == [(order_id, order_id)] * len(expected_rows)
            assert [sheet[f"{c}2"].value for c in ("E", "F", "G", "J", "M")] == [
                "SHEN", "深圳", "中国", 111111, "深圳龙华"]
            assert all(sheet.cell(r, 4)._style == template["D2"]._style for r in range(2, sheet.max_row + 1))


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


@pytest.mark.parametrize(("changes", "expected"), [
    # Dates closer to today win over later dates.
    ({"BB1": "11/20空运", "BG1": "11/20海运", "BC1": "11/5A海运", "BD1": "11/5B海运"},
     [("sea_a", "IN261105A-H", 55, [20, None, None]),
      ("sea_b", "IN261105B-H", 56, [None, 22, None])]),
    ({"BH1": "11/5d海运", "BH2": 33},
     [("sea_d", "IN261105D-H", 60, [33, None, None])]),
    # The latest ordinary and A/B sea batches coexist; duplicated older columns
    # do not interfere, and an empty air column produces no SKU rows.
    ({"BC1": "11/6A海运", "BD1": "11/6B海运", "BE1": "11/4海运",
      "BB2": None, "BB3": 0, "BB4": None},
     [("air", "IN261106-K", 54, [None, None, None]), ("sea", "IN261106-H", 59, [None, 8, 4]),
      ("sea_a", "IN261106A-H", 55, [20, None, None]), ("sea_b", "IN261106B-H", 56, [None, 22, None])]),
])
def test_indonesia_exports_all_modes_at_closest_sea_date(invoke, changes, expected):
    code, result, _ = invoke("indonesia", changes)
    assert code == 0 and result["ok"]
    artifacts = result["data"]["artifacts"]
    assert [(a["field"], a["order_id"], a["shipping_column"]) for a in artifacts] == [
        (field, order, column) for field, order, column, _ in expected]
    for artifact, (_, order, _, quantities) in zip(artifacts, expected, strict=True):
        assert Path(artifact["path"]).name == f"印尼马帮订单导入模板-{order}.xlsx"
        expected_rows = [(sku, 0, q) for sku, q in zip(["SKU-A", "SKU-B", "SKU-A"], quantities) if q is not None]
        assert artifact["sku_count"] == artifact["quantity_value_count"] == len(expected_rows)
        with open_sheet(artifact["path"]) as sheet:
            assert rows(sheet) == expected_rows


@pytest.mark.parametrize(("changes", "expected_id", "expected_column", "expected_quantities"), [
    ({"BA1": None, "BB1": None}, "IN261106-H", 59, [None, 8, 4]),
    ({"BC1": None, "BD1": None, "BE1": None, "BF1": None, "BG1": None},
     "IN261106-K", 54, [10, None, None]),
    ({"BA1": None, "BB1": None, "BC1": None, "BD1": None, "BE1": None, "BF1": None,
      "BG1": None, "BH1": "11/7陆运", "BH2": 17}, "IN261107-L", 60, [17, None, None]),
])
def test_indonesia_allows_one_transport_mode(invoke, changes, expected_id, expected_column, expected_quantities):
    code, result, _ = invoke("indonesia", changes)
    assert code == 0 and result["ok"]
    artifacts = result["data"]["artifacts"]
    assert len(artifacts) == 1
    assert (artifacts[0]["order_id"], artifacts[0]["shipping_column"]) == (expected_id, expected_column)
    assert Path(artifacts[0]["path"]).name == f"印尼马帮订单导入模板-{expected_id}.xlsx"
    with open_sheet(artifacts[0]["path"]) as sheet:
        assert rows(sheet) == [(sku, 0, q) for sku, q in zip(["SKU-A", "SKU-B", "SKU-A"], expected_quantities) if q is not None]


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
    assert set(artifacts) == {f"IN261106{batch}-{code}" for batch in ("", "A", "B", "C")}
    for batch, quantity in zip(("", "A", "B", "C"), (11, 22, 33, 44), strict=True):
        order = f"IN261106{batch}-{code}"
        artifact = artifacts[order]
        assert artifact["field"] == (f"{field}_{batch.lower()}" if batch else field)
        assert artifact["shipping_mode"] == f"{batch}{mode}"
        expected_rows = [("SKU-A", 0, quantity)] + ([("SKU-B", 0, 22)] if batch == "C" else [])
        assert artifact["sku_count"] == len(expected_rows)
        with open_sheet(artifact["path"]) as sheet:
            assert rows(sheet) == expected_rows


@pytest.mark.parametrize("header", ["海运/空运合计", "海运7/30天销量"])
def test_indonesia_ignores_non_date_headers(invoke, header):
    code, result, _ = invoke("indonesia", {"BH1": header})
    assert code == 0 and result["ok"]
    assert [(item["order_id"], item["shipping_column"]) for item in result["data"]["artifacts"]] == [
        ("IN261106-K", 54), ("IN261106-H", 59),
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


@pytest.mark.parametrize("arguments", [{}, {"input_xlsx": "source.xlsx"},
    {"country": "brazil", "input_xlsx": "source.xlsx", "unknown": True},
    {"country": "malaysia", "input_xlsx": "source.xlsx", "shipping_column": "BD"},
    {"country": "malaysia", "input_xlsx": "source.xlsx", "air_shipping_column": "AO"},
    {"country": "philippines", "input_xlsx": "source.xlsx", "air_shipping_column": ""}])
def test_invalid_arguments(arguments):
    assert command.run(arguments)["error"]["code"] == "invalid_arguments"


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
    ("brazil", "BR"), ("malaysia", "MY"), ("vietnam", "VN"), ("philippines", "PH"), ("indonesia", "IN"),
])
def test_five_countries_only_export_globally_closest_date(invoke, country, prefix):
    changes = unified_headers(country, {
        "BJ": ("11/4空运", 10), "BK": ("11/5A海运", 20), "BL": ("11/5B海运", 30),
    })
    code, result, _ = invoke(country, changes, yellow_headers=("BJ1", "BK1"))
    assert code == 0 and result["ok"]
    artifacts = {item["order_id"]: item for item in result["data"]["artifacts"]}
    assert set(artifacts) == {f"{prefix}261105A-H", f"{prefix}261105B-H"}
    for order, quantity in ((f"{prefix}261105A-H", 20), (f"{prefix}261105B-H", 30)):
        with open_sheet(artifacts[order]["path"]) as sheet:
            assert rows(sheet) == [("SKU-A", 0, quantity)]


@pytest.mark.parametrize(("country", "prefix"), [
    ("brazil", "BR"), ("malaysia", "MY"), ("vietnam", "VN"), ("philippines", "PH"), ("indonesia", "IN"),
])
def test_five_countries_export_all_columns_on_one_closest_date(invoke, country, prefix):
    changes = unified_headers(country, {
        "BJ": ("11/1陆运", 1), "BK": ("11/5陆运", 2), "BL": ("11/5A陆运", 3),
        "BM": ("11/5空运", 4), "BN": ("11/7c空运", 5),
        "BO": ("11/5海运", 6), "BP": ("11/5B海运", 7),
        "BQ": ("11/5a空运", 9), "BR": ("11/5b陆运", 10),
        "BS": ("11/1C海运", 11),
        "BT": ("11/20A海运", 12), "BU": ("11/20B海运", 13), "BV": ("11/20空运", 14),
    })
    code, result, _ = invoke(country, changes, yellow_headers=("BS1",))
    assert code == 0 and result["ok"]
    artifacts = {item["order_id"]: item for item in result["data"]["artifacts"]}
    expected = {
        f"{prefix}261105-L": ("11/5陆运", 2), f"{prefix}261105A-L": ("11/5A陆运", 3),
        f"{prefix}261105B-L": ("11/5b陆运", 10), f"{prefix}261105-K": ("11/5空运", 4),
        f"{prefix}261105A-K": ("11/5a空运", 9), f"{prefix}261105-H": ("11/5海运", 6),
        f"{prefix}261105B-H": ("11/5B海运", 7),
    }
    assert set(artifacts) == set(expected)
    for order, (header, quantity) in expected.items():
        assert artifacts[order]["shipping_header"] == header
        with open_sheet(artifacts[order]["path"]) as sheet:
            assert rows(sheet) == [("SKU-A", 0, quantity)]


@pytest.mark.parametrize(("country", "prefix", "mode", "suffix"), [
    ("brazil", "BR", "陆运", "L"), ("malaysia", "MY", "空运", "K"),
    ("vietnam", "VN", "海运", "H"), ("philippines", "PH", "陆运", "L"),
])
def test_four_countries_allow_a_single_transport(invoke, country, prefix, mode, suffix):
    changes = unified_headers(country, {"BJ": (f"11/6C{mode}", 8)})
    code, result, _ = invoke(country, changes)
    assert code == 0 and result["ok"]
    assert result["data"]["order_ids"] == [f"{prefix}261106C-{suffix}"]


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


@pytest.mark.parametrize("country", ["brazil", "malaysia", "vietnam", "philippines", "indonesia"])
@pytest.mark.parametrize("failure", ["collision", "damaged_file"])
def test_partial_outputs_are_removed_after_real_filesystem_failure(invoke, tmp_path, country, failure):
    changes = unified_headers(country, {"BJ": ("11/6陆运", 1), "BK": ("11/6空运", 2)})
    with interfere_with_publication(tmp_path, failure) as observed:
        code, result, source = invoke(country, changes)
    assert observed["first_published"]
    assert code != 0 and not result["ok"] and result["files"] == []
    if failure == "collision":
        assert observed["second_output"].name in result["error"]["message"]
    else:
        assert "生成结果文件不存在或为空" in result["error"]["message"]
    assert not observed["first_output"].parent.exists()
    assert list(source.parent.rglob("*.xlsx")) == [source]
