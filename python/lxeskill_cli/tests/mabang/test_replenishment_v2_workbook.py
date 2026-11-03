"""Real CLI -> verified XLSX inputs -> Office recalculation -> published artifact."""
import hashlib
import os
from pathlib import Path

import pytest
from openpyxl import load_workbook

from replenishment_cases import STORE, batch, cells, cli, edit_cell, generate, product
from services.mabang.amazon.fba import replenishment_v2_settings as settings
from shared.office.execution import run_kit_bounded


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setenv("LXE_DATA_ROOT", str(tmp_path / "state"))
    monkeypatch.setenv("LXE_WORKSPACE_ROOT", str(tmp_path))
    monkeypatch.setenv("LXESKILL_SKILL_SCOPE", "replenishment-workflow-map")
    monkeypatch.delenv("LXE_AGENT_SESSION_ID", raising=False)


@pytest.fixture
def office():
    if not all(os.environ.get(key) for key in ("LXE_OFFICE_NODE", "LXE_OFFICE_CLI")):
        pytest.skip("Office Kit unavailable: workbook calculation NOT VERIFIED")


def test_cli_publishes_all_rows_with_real_calculated_values(tmp_path, office):
    inputs = batch(tmp_path, rows=[product(), product("CLEAR", **{"备注": "清货", "单品重量(g)(cm)": None}),
                                  product("COMBO", **{"本地SKU": "C"})], shipment_rows=[("SEA", 10)])
    hashes = [hashlib.sha256(path.read_bytes()).digest() for path in inputs]
    result = generate(inputs)
    assert result["ok"] and result["files"] == [result["data"]["output_xlsx_path"]]
    actual = cells(result["files"][0])
    assert set(actual) == {"SEA", "CLEAR", "COMBO"}
    sea = actual["SEA"]
    assert [sea[col] for col in ("A", "C", "D", "E", "F", "G", "H")] == [STORE, "PARENT", "ASIN-SEA", 42, 84, 180, 540]
    assert [sea[col] for col in ("I", "J", "N", "R", "S", "T", "U")] == ["平稳", 6, 999, 480, 80, 10, "海运"]
    assert [sea[col] for col in ("V", "W", "Y", "AB", "AC", "AD", "AE", "AG", "AH", "AI")] == [75, 90, None, 50, 5000, 100, "=2+2", 12, "S", 90]
    assert actual["COMBO"]["AG"] == 7  # min(20 / 2, 21 / 3), not component stock sum.
    assert [actual["CLEAR"][col] for col in ("U", "Y", "AB", "AC", "AD")] == [None, None, None, None, 0]
    assert [hashlib.sha256(path.read_bytes()).digest() for path in inputs] == hashes
    # Users can edit the delivered workbook and recalculate it; cached/static values cannot pass.
    edited = tmp_path / "edited.xlsx"
    book = load_workbook(result["files"][0])
    for column, value in (("E", 84), ("F", 168), ("G", 360)):
        book.active[f"{column}2"] = value
    book.save(edited)
    book.close()
    recalculated = tmp_path / "edited-calculated.xlsx"
    process = run_kit_bounded(["recalculate", "--input", str(edited), "--output", str(recalculated)], timeout_seconds=90)
    assert process.returncode == 0, process.stderr
    updated = cells(recalculated)["SEA"]
    assert [updated[col] for col in ("J", "S", "U", "Y", "AI")] == [12, 40, "空运（急发）", 590, 90]


@pytest.mark.parametrize("saved,flags,expected", [
    ((False, None), [], (90, 95)),
    ((True, 20), [], (110, 115)),
    ((False, 20), ["--peak-boost-enabled"], (110, 115)),
    ((True, 20), ["--peak-boost-enabled=false"], (90, 95)),
    ((False, None), ["--peak-boost-days", "15"], (105, 110)),
])
def test_saved_and_per_run_settings_change_workbook_without_changing_saved_state(tmp_path, office, saved, flags, expected):
    parameters = {"peak_boost_enabled": saved[0], "peak_boost_days": saved[1]}
    settings.save_parameters(parameters)
    inputs = batch(tmp_path, rows=[product(**{"7天销量": 77, "14天销量": 154, "30天销量": 330,
                                              "可售": 850, "备注": "热销"})])
    result = generate(inputs, *flags)
    actual = cells(result["files"][0])["SEA"]
    assert (actual["V"], actual["W"]) == expected
    assert settings.read_state() == parameters


@pytest.mark.parametrize("problem,diagnostic", [
    ("source-changed", "发生变化"), ("other-batch", "批次"), ("missing-msku", "覆盖"),
    ("duplicate-msku", "重复"), ("other-day", "日期"), ("orphan-shipment", "源表没有"),
    ("unknown-sales", "可售"), ("invalid-weight", "AD重量"), ("invalid-shipment", "未关联数量"),
])
def test_cli_rejects_inconsistent_inputs_without_publishing(tmp_path, problem, diagnostic):
    options = {}
    if problem == "other-day":
        options["snapshot_time"] = "202610121100"
    if problem == "orphan-shipment":
        options["shipment_rows"] = [("ORPHAN", 3)]
    if problem == "invalid-shipment":
        options["shipment_rows"] = [("SEA", 3)]
    if problem in {"unknown-sales", "invalid-weight"}:
        options["rows"] = [product(**({"可售": None} if problem == "unknown-sales" else {"单品重量(g)(cm)": "bad-weight"}))]
    source, report, snapshot = batch(tmp_path, **options)
    if problem == "source-changed":
        edit_cell(source, "7天销量", 99)
    elif problem == "other-batch":
        report = batch(tmp_path / "different")[1]
    elif problem == "invalid-shipment":
        edit_cell(snapshot, "未关联数量", "invalid")
    elif problem in {"missing-msku", "duplicate-msku"}:
        book = load_workbook(report)
        ws = book["真实库存（深圳仓库）-库存sku"]
        if problem == "missing-msku":
            ws.delete_rows(2)
        else:
            ws.append([cell.value for cell in ws[2]])
        book.save(report)
        book.close()
    result = generate((source, report, snapshot), expected=4)
    assert not result["ok"] and result["files"] == []
    assert diagnostic in result["error"]["message"]
    assert not list((tmp_path / ".lxeagent/artifacts/replenish/v2").glob("*.xlsx"))


def test_wrong_scope_and_wrong_store_do_not_deliver_a_workbook(tmp_path, monkeypatch):
    inputs = batch(tmp_path)
    monkeypatch.setenv("LXESKILL_SKILL_SCOPE", "replenishment-calculate")
    blocked = generate(inputs, expected=3)
    assert blocked["error"]["code"] == "skill_not_in_scope" and blocked["files"] == []
    monkeypatch.setenv("LXESKILL_SKILL_SCOPE", "replenishment-workflow-map")
    wrong_store = generate(inputs, "--store-name", "Other-Store", expected=4)
    assert "店铺不一致" in wrong_store["error"]["message"] and wrong_store["files"] == []


def test_unbound_and_missing_stock_rows_remain_in_diagnostic_workbook(tmp_path, office):
    inputs = batch(tmp_path, rows=[product(), product("UNBOUND", **{"本地SKU": ""}),
                                  product("MISSING", **{"本地SKU": "UNKNOWN"})])
    result = generate(inputs)
    assert result["ok"]
    assert result["data"]["unknown_inventory_count"] == 2
    rows = cells(result["files"][0])
    assert set(rows) == {"SEA", "UNBOUND", "MISSING"}
    assert rows["UNBOUND"]["AG"] is None and rows["MISSING"]["AG"] is None
    assert rows["MISSING"]["AH"] == "UNKNOWN"
    assert rows["MISSING"]["J"] == 6 and rows["UNBOUND"]["AB"] == 60


def test_unknown_inventory_is_delivered_and_preserves_previous_success(tmp_path, office):
    source, report, snapshot = batch(tmp_path)
    success = generate((source, report, snapshot))
    published = Path(success["files"][0])
    original = published.read_bytes()
    edit_cell(report, "真实库存（深圳仓库）数量", None, sheet="真实库存（深圳仓库）-库存sku")
    result = generate((source, report, snapshot))
    assert result["ok"] and "error" not in result
    assert result["data"]["unknown_inventory_count"] == 1
    diagnostic = Path(result["data"]["output_xlsx_path"])
    assert "库存待核对" in diagnostic.name
    assert result["files"] == [str(diagnostic)] and diagnostic != published
    assert cells(diagnostic)["SEA"]["AG"] is None
    assert cells(diagnostic)["SEA"]["AB"] == 60
    assert published.read_bytes() == original
    # A genuine zero or negative balance is known inventory, not a missing value.
    for quantity in (0, -3):
        edit_cell(report, "真实库存（深圳仓库）数量", quantity, sheet="真实库存（深圳仓库）-库存sku")
        assert cells(generate((source, report, snapshot))["files"][0])["SEA"]["AG"] == quantity


def test_office_process_failure_preserves_output_and_actual_diagnostic(tmp_path, monkeypatch, office):
    inputs = batch(tmp_path)
    published = Path(generate(inputs)["files"][0])
    original = published.read_bytes()
    missing = tmp_path / "missing-office-cli.js"
    monkeypatch.setenv("LXE_OFFICE_CLI", str(missing))
    result = generate(inputs, expected=4)
    assert not result["ok"] and result["files"] == []
    assert str(missing) in result["error"]["message"]
    assert published.read_bytes() == original


def test_same_files_still_work_for_v1_when_v2_inventory_is_unknown(tmp_path, monkeypatch, office):
    artifact_root = tmp_path / ".lxeagent/artifacts/replenish"
    inputs = batch(artifact_root)
    for key, folder in (("MABANG_STORE_MSKU_OUTPUT_DIR", "store_msku"),
                        ("MABANG_STORE_MSKU_ANALYSIS_OUTPUT_DIR", "sales"),
                        ("MABANG_STORE_MSKU_INVENTORY_OUTPUT_DIR", "actual_inventory"),
                        ("MABANG_STORE_MSKU_REPLENISHMENT_OUTPUT_DIR", "v1")):
        monkeypatch.setenv(key, str(artifact_root / folder))
    monkeypatch.setenv("LXESKILL_SKILL_SCOPE", "replenishment-sales-analyze")
    assert cli("replenish", "sales", "analyze", "--store-name", STORE)["ok"]
    monkeypatch.setenv("LXESKILL_SKILL_SCOPE", "replenishment-calculate")
    v1 = cli("replenish", "calculate", "--store-name", STORE, "--unlinked-shipments-snapshot", inputs[2])
    artifact = Path(v1["files"][0])
    original = artifact.read_bytes()
    monkeypatch.setenv("LXESKILL_SKILL_SCOPE", "replenishment-workflow-map")
    edit_cell(inputs[1], "真实库存（深圳仓库）数量", None, sheet="真实库存（深圳仓库）-库存sku")
    result = generate(inputs)
    assert result["ok"] and result["data"]["unknown_inventory_count"] == 1
    assert artifact.read_bytes() == original
