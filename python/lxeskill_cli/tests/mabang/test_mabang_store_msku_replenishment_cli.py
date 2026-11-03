"""Unified command tests use real input files, subprocesses and published workbooks."""
from pathlib import Path

import pytest
from openpyxl import load_workbook

from replenishment_cases import STORE, batch, cli, edit_cell, generate, product
from test_mabang_store_msku_replenishment import (
    _write_amazon_fba_inventory_snapshot, _write_amazon_restock_inventory_snapshot,
)


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setenv("LXE_DATA_ROOT", str(tmp_path / "state"))
    monkeypatch.setenv("LXE_WORKSPACE_ROOT", str(tmp_path))
    monkeypatch.setenv("LXESKILL_SKILL_SCOPE", "replenishment-workflow-map")
    monkeypatch.delenv("LXE_AGENT_SESSION_ID", raising=False)


def records(path, sheet="最终备货意见"):
    book = load_workbook(path, data_only=True)
    try:
        values = book[sheet].iter_rows(min_row=2, values_only=True)
        headers = next(values)
        return {row[0]: dict(zip(headers, row)) for row in values}
    finally:
        book.close()


@pytest.mark.parametrize("template,quantity", [("默认", 50), ("US-一组", 170), ("UK-一组", 0)])
def test_v1_calculates_from_explicit_source_without_sales_report(tmp_path, template, quantity):
    inputs = batch(tmp_path / "chosen", rows=[product(), product("CLEAR", **{"备注":"清货"}),
        product("LOW", **{"7天销量":2,"14天销量":4,"30天销量":9}),
        product("UNBOUND", **{"本地SKU":""})], shipment_rows=[("SEA",10)])
    # A different local batch must not replace the explicit source.
    batch(tmp_path / ".lxeagent/artifacts/replenish", rows=[product("DISTRACTOR")])
    original = [path.read_bytes() for path in inputs]
    result = generate(inputs, "--template", template, version="v1")
    data = result["data"]
    assert result["ok"] and result["files"] == [data["output_xlsx_path"]]
    assert data["version"] == "v1" and data["row_count"] == 3
    assert data["source_data_time"] == "202610131000"
    assert [data[k] for k in ("msku_source_xlsx_path", "shenzhen_inventory_report_xlsx_path", "unlinked_shipments_snapshot_path")] == list(map(str,inputs))
    shipped = records(result["files"][0])
    excluded = records(result["files"][0], "本轮不备货")
    if quantity:
        assert set(shipped) == {"SEA"}
        assert shipped["SEA"]["海运建议量"] == quantity
        assert shipped["SEA"]["未发出货件总计"] == 10
        assert shipped["SEA"]["FBA总库存（马帮）"] == 480
        assert excluded["CLEAR"]["未备货原因分类"] == "清货"
    else:
        assert not shipped and excluded["SEA"]["未备货原因分类"] == "海运未启用"
    assert excluded["LOW"]["未备货原因分类"] == "样本不足"
    assert [path.read_bytes() for path in inputs] == original


@pytest.mark.parametrize("version", ["v1","v2"])
@pytest.mark.parametrize("problem,message", [("file","不存在"),("source","发生变化"),("batch","批次"),("day","日期"),("store","店铺不一致")])
def test_shared_input_validation_never_publishes(tmp_path, version, problem, message):
    inputs = list(batch(tmp_path / "chosen", snapshot_time="202610121100" if problem == "day" else "202610131100"))
    options = []
    if problem == "file": inputs[0] = tmp_path / "missing.xlsx"
    if problem == "source": edit_cell(inputs[0], "7天销量", 999)
    if problem == "batch": inputs[1] = batch(tmp_path / "other")[1]
    if problem == "store": options = ["--store-name","Other"]
    result = generate(inputs, *options, version=version, expected=4)
    assert message in result["error"]["message"] and result["files"] == []


@pytest.mark.parametrize("version,options,expected", [
    ("v1",["--peak-boost-enabled=false"],4), ("v1",["--peak-boost-days","20"],4),
    ("v2",["--template","默认"],4), ("v2",["--amazon-fba-inventory-snapshot","unused.xlsx"],4),
    ("both",[],4), ("v2",["--peak-boost-enabled=invalid"],2),
])
def test_version_and_option_errors_are_visible(tmp_path, version, options, expected):
    result = generate(batch(tmp_path), *options, version=version, expected=expected)
    assert not result["ok"] and result["error"]["message"] and result["files"] == []


@pytest.mark.parametrize("missing", ["version", "store-name", "msku-source-xlsx-path", "shenzhen-inventory-report-xlsx-path", "unlinked-shipments-snapshot-path"])
def test_missing_explicit_inputs_are_rejected(tmp_path, missing):
    source, inventory, shipments = batch(tmp_path)
    arguments = {"version": "v1", "store-name": STORE, "msku-source-xlsx-path": source,
                 "shenzhen-inventory-report-xlsx-path": inventory, "unlinked-shipments-snapshot-path": shipments}
    del arguments[missing]
    flags = [value for key, value in arguments.items() for value in ("--" + key, value)]
    result = cli("replenish", "calculate", *flags, expected=4)
    assert not result["ok"] and result["files"] == []


def test_failure_preserves_previous_v1_output(tmp_path):
    inputs = batch(tmp_path)
    path = Path(generate(inputs,version="v1")["files"][0])
    original = path.read_bytes()
    edit_cell(inputs[0],"30天销量",999)
    assert not generate(inputs,version="v1",expected=4)["ok"]
    assert path.read_bytes() == original


@pytest.mark.parametrize("column", ["7天销量", "商品链接", "单品重量(g)(cm)"])
def test_v1_missing_source_columns_do_not_turn_into_defaults(column):
    from services.mabang.amazon.fba.store_msku_sales_analysis import analyze_msku_rows
    from services.mabang.amazon.fba.store_msku_replenishment import sales_details_from_records
    row = product()
    del row[column]
    with pytest.raises(ValueError) as error:
        sales_details_from_records(analyze_msku_rows([row], headers=list(row)))
    assert column in str(error.value)


@pytest.mark.parametrize("kind,writer", [("fba",_write_amazon_fba_inventory_snapshot),("restock",_write_amazon_restock_inventory_snapshot)])
@pytest.mark.parametrize("date,expected", [("20261012",0),("20261013",0),("20261014",0),("20261011",4),("invalid",4)])
def test_optional_amazon_comparison_preserves_execution_and_validates_dates(tmp_path,kind,writer,date,expected):
    inputs = batch(tmp_path)
    snapshot = writer(tmp_path / "comparison.xlsx", snapshot_date=date)
    result = generate(inputs,f"--amazon-{kind}-inventory-snapshot",snapshot,version="v1",expected=expected)
    if expected:
        assert "日期" in result["error"]["message"] and result["files"] == []
    else:
        assert result["data"][f"amazon_{kind}_inventory_snapshot_path"] == str(snapshot)
        assert result["data"][f"amazon_{kind}_inventory_validation"]["amazon_sku_match_ratio"] == .8
        assert records(result["files"][0])["SEA"]["海运建议量"] == 60
