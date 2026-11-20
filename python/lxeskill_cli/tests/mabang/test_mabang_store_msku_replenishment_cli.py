"""Unified command tests use real input files, subprocesses and published workbooks."""
from pathlib import Path

import pytest
from openpyxl import load_workbook

from replenishment_cases import STORE, batch, cli, edit_cell, generate, product


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setenv("LXE_DATA_ROOT", str(tmp_path / "state"))
    monkeypatch.setenv("LXE_WORKSPACE_ROOT", str(tmp_path))
    monkeypatch.setenv("LXESKILL_SKILL_SCOPE", "amazon-replenishment")
    monkeypatch.delenv("LXE_AGENT_SESSION_ID", raising=False)


def records(path, sheet="最终备货意见"):
    book = load_workbook(path, data_only=True)
    try:
        values = book[sheet].iter_rows(min_row=1, values_only=True)
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
    assert Path(result["files"][0]).name == "202610131000-Amazon-Test_备货建议-v1.xlsx"
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


@pytest.mark.parametrize("version", ["v1", "v2"])
@pytest.mark.parametrize("matched_quantity", [0, 10])
def test_shipments_outside_source_warn_without_affecting_calculation(tmp_path, version, matched_quantity):
    shipments = [("OUTSIDE-A", 100), ("OUTSIDE-B", 2.5)]
    if matched_quantity:
        shipments.append(("SEA", matched_quantity))
    inputs = batch(tmp_path, shipment_rows=shipments)
    original = [path.read_bytes() for path in inputs]
    result = generate(inputs, version=version)
    assert result["ok"] and result["files"] == [result["data"]["output_xlsx_path"]]
    warning, = result["data"]["warnings"]
    assert "2 个 MSKU（合计 102.5 件）" in warning
    assert "未参与本轮计算" in warning and "OUTSIDE-A" in warning and "OUTSIDE-B" in warning
    book = load_workbook(result["files"][0], data_only=True)
    try:
        ws = book["最终备货意见"] if version == "v1" else book["mskulist"]
        headers = [cell.value for cell in ws[1]]
        row, = [dict(zip(headers, values)) for values in ws.iter_rows(min_row=2, values_only=True)]
        assert row["MSKU"] == "SEA"
        assert row["未发出货件总计"] == matched_quantity
        sea_column = "海运建议量" if version == "v1" else "海运实际"
        assert row[sea_column] == 60 - matched_quantity
        if version == "v1":
            assert book["本轮不备货"].max_row == 1
            summary = records(result["files"][0], "链接备货汇总")["PARENT"]
            assert summary["链接未关联数量汇总"] == matched_quantity
            assert summary["总补货量"] == 60 - matched_quantity
    finally:
        book.close()
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
    ("v2",["--template","默认"],4),
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
    from services.mabang.amazon.fba.store_msku_replenishment import sales_detail_from_record
    row = product()
    del row[column]
    with pytest.raises(ValueError) as error:
        sales_detail_from_record(analyze_msku_rows([row], headers=list(row))[0])
    assert column in str(error.value)


@pytest.mark.parametrize("version", ["v1", "v2"])
@pytest.mark.parametrize("second", [
    {},
    {"7天销量": 84, "14天销量": 168, "30天销量": 360, "可售": 900},
    {"本地SKU": "C", "7天销量": 84, "14天销量": 168, "30天销量": 360, "可售": 900},
])
def test_duplicate_msku_rows_calculate_individually_and_warn(tmp_path, version, second):
    inputs = batch(tmp_path, rows=[product(), product(**second)], shipment_rows=[("SEA", 10)])
    result = generate(inputs, version=version)
    assert result["ok"] and result["data"]["row_count"] == 2
    assert any("SEA（2行）" in warning and "数量可能重复累计" in warning
               for warning in result["data"]["warnings"])
    book = load_workbook(result["files"][0], data_only=True)
    try:
        ws = book["最终备货意见"] if version == "v1" else book.active
        header_row = 1
        headers = [cell.value for cell in ws[header_row]]
        rows = [dict(zip(headers, row)) for row in ws.iter_rows(min_row=header_row + 1, values_only=True)]
        assert len(rows) == 2
        assert all(row["MSKU"] == "SEA" and row["未发出货件总计"] == 10 for row in rows)
        inventory_column = "深圳可用库存" if version == "v1" else "本地库存"
        sea_column = "海运建议量" if version == "v1" else "海运实际"
        air_column = "空运建议量" if version == "v1" else "空运实际"
        # Daily sales 6/12, sea coverage 90/95 days, minus FBA 480/930 and 10 pending units.
        # V2 allocates 140 of the second row's 200 units to air before sea.
        expected_second = (84, 930, 7 if second.get("本地SKU") == "C" else 12,
                           200 if version == "v1" else 60, 0 if version == "v1" else 140)
        expected_first = (42, 480, 12, 50, 0)
        assert sorted((row["7天销量"], row["FBA总库存（马帮）"], row[inventory_column],
                       row[sea_column], row[air_column] or 0) for row in rows) == [
            expected_first, expected_second if second else expected_first]
        if version == "v1":
            summary = book["链接备货汇总"]
            record = dict(zip((cell.value for cell in summary[1]), (cell.value for cell in summary[2])))
            assert (record["MSKU数"], record["链接未关联数量汇总"], record["总补货量"]) == (2, 20, 250 if second else 100)
    finally:
        book.close()


@pytest.mark.parametrize("column,value,message", [
    ("MSKU", "OTHER", "缺少匹配行"),
    ("本地SKU", "OTHER", "缺少匹配行"),
    ("FBA总库存", 999, "库存分项与真实库存报表不一致"),
])
def test_v1_inventory_mismatch_still_reports_actual_cause(tmp_path, column, value, message):
    inputs = batch(tmp_path)
    edit_cell(inputs[1], column, value, sheet="真实库存（深圳仓库）-库存sku")
    result = generate(inputs, version="v1", expected=4)
    assert message in result["error"]["message"] and result["files"] == []


@pytest.mark.parametrize("version", ["v1", "v2"])
def test_asin_descriptions_do_not_change_msku_matching(tmp_path, version):
    inputs = batch(tmp_path)
    for column in ("父ASIN", "ASIN"):
        edit_cell(inputs[1], column, "different-description", sheet="真实库存（深圳仓库）-库存sku")
    result = generate(inputs, version=version)
    assert result["ok"] and result["data"]["warnings"] == []
    book = load_workbook(result["files"][0], data_only=True)
    try:
        ws = book["最终备货意见"] if version == "v1" else book.active
        header_row = 1
        record = dict(zip((cell.value for cell in ws[header_row]), (cell.value for cell in ws[header_row + 1])))
        assert (record["MSKU"], record["ASIN"]) == ("SEA", "ASIN-SEA")
        if version == "v1":
            assert book["链接备货汇总"]["A2"].value == "PARENT"
        else:
            assert record["父ASIN"] == "PARENT"
    finally:
        book.close()
