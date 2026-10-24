from __future__ import annotations

from decimal import Decimal
import hashlib
import os
from pathlib import Path
from shutil import copyfile
import subprocess
from unittest.mock import Mock

import pytest
from openpyxl import Workbook, load_workbook

from services.mabang.amazon.fba import replenishment_v2_workbook as v2_workbook
from services.mabang.amazon.fba import replenishment_v2_settings as settings
from services.mabang.amazon.fba import source_verification
from services.mabang.amazon.fba import store_msku_actual_inventory as inventory
from services.mabang.amazon.fba import unlinked_shipments as shipments
from services.mabang.amazon.fba.replenishment_v2_formulas import replenishment_v2_formulas
from services.mabang.amazon.fba.sku_catalog import LocalSkuDefinition, SkuCatalogSnapshot
from services.mabang.amazon.fba.store_msku_replenishment import StoreMskuReplenishmentError
from services.mabang.amazon.fba.replenishment_v2_workbook import (
    ReplenishmentV2WorkbookError,
    generate_replenishment_v2,
)


STORE = "Amazon-Test"


@pytest.fixture(autouse=True)
def isolated_settings(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("LXE_DATA_ROOT", str(tmp_path / "app"))


def test_workbook_writes_formulas_using_persisted_boost_choice(tmp_path: Path) -> None:
    path = tmp_path / "formula-setting.xlsx"
    v2_workbook._write_workbook(path, [{"_binding_verified": True}], peak_boost_enabled=False)
    book = load_workbook(path, data_only=False)
    try:
        sheet = book[v2_workbook.WORKSHEET_NAME]
        assert 'SEARCH("热销",AF2)' not in sheet["V2"].value
        assert "+0,120" in sheet["V2"].value
        assert "+0,120" in sheet["W2"].value
        assert sheet["I2"].value == replenishment_v2_formulas(2)["I"]
    finally:
        book.close()
SOURCE_HEADERS = (
    "店铺名称", "MSKU", "父ASIN", "ASIN", "本地SKU", "本地SKU名称", "商品名称", "备注",
    "7天销量", "14天销量", "30天销量", "90天销量", "可售", "待入库", "预留",
    "计划入库", "在途", "待调仓", "调仓中", "单品重量(g)(cm)",
)


def _source_rows() -> list[dict[str, object]]:
    return [
        {
            "MSKU": "SEA-1", "父ASIN": "PARENT-SEA", "ASIN": "ASIN-SEA", "本地SKU": "SKU-SEA",
            "本地SKU名称": "Ocean item", "备注": "", "7天销量": 77, "14天销量": 154,
            "30天销量": 330, "90天销量": 990, "可售": 880, "待入库": 0, "预留": 0,
            "计划入库": 17, "在途": 0, "待调仓": 0, "调仓中": 0, "单品重量(g)(cm)": "50g 10*10*10",
        },
        {
            "MSKU": "CLEAR-1", "父ASIN": "PARENT-CLEAR", "ASIN": "ASIN-CLEAR", "本地SKU": "SKU-CLEAR",
            "本地SKU名称": "Clearance item", "备注": "清货", "7天销量": 7, "14天销量": 14,
            "30天销量": 30, "90天销量": 90, "可售": 0, "待入库": 0, "预留": 0,
            "计划入库": 0, "在途": 0, "待调仓": 0, "调仓中": 0, "单品重量(g)(cm)": 50,
        },
        {
            "MSKU": "COMBO-1", "父ASIN": "PARENT-COMBO", "ASIN": "ASIN-COMBO", "本地SKU": "SKU-COMBO",
            "本地SKU名称": "Combo item", "备注": "", "7天销量": 7, "14天销量": 14,
            "30天销量": 30, "90天销量": 90, "可售": 0, "待入库": 0, "预留": 0,
            "计划入库": 0, "在途": 0, "待调仓": 0, "调仓中": 0, "单品重量(g)(cm)": 25,
        },
        {
            "MSKU": "UNBOUND-1", "父ASIN": "PARENT-UNBOUND", "ASIN": "ASIN-UNBOUND", "本地SKU": "UNVERIFIED-LOCAL",
            "本地SKU名称": "Unbound item", "备注": "", "7天销量": 7, "14天销量": 14,
            "30天销量": 30, "90天销量": 90, "可售": 0, "待入库": 0, "预留": 0,
            "计划入库": 0, "在途": 0, "待调仓": 0, "调仓中": 0, "单品重量(g)(cm)": 50,
        },
    ]


def _write_source(
    path: Path, rows: list[dict[str, object]] | None = None,
    *, headers: tuple[str, ...] = SOURCE_HEADERS,
    local_skus: tuple[LocalSkuDefinition, ...] | None = None,
) -> Path:
    rows = _source_rows() if rows is None else rows
    path.parent.mkdir(parents=True, exist_ok=True)
    workbook = Workbook()
    sheet = workbook.active
    sheet.append(headers)
    for row in rows:
        sheet.append([row.get(header) for header in headers])
        # Model an authoritative source whose strings remain literal text.
        for cell in sheet[sheet.max_row]:
            if isinstance(cell.value, str):
                cell.data_type = "s"
    workbook.save(path)
    workbook.close()
    if local_skus is None:
        local_skus = tuple(
            LocalSkuDefinition(str(row["本地SKU"]), None if row["MSKU"] == "UNBOUND-1" else 1)
            for row in rows if str(row.get("本地SKU") or "").strip()
        )
    source_verification.annotate_source(
        path,
        SkuCatalogSnapshot(STORE, "401403", "shopId", local_skus),
        requested_store_name=STORE,
    )
    return path


def _write_inventory_report(path: Path, source_path: Path, rows: list[dict[str, object]] | None = None) -> Path:
    source = source_verification.load_verified_source(source_path, store_name=STORE)
    rows = _source_rows() if rows is None else rows
    inventory_rows = []
    verdicts = {record["MSKU"]: record["是否通过绑定核验"] for record in source.records}
    for row in rows:
        child_skus = "SKU-CHILD * 2" if row["MSKU"] == "COMBO-1" else ""
        inventory_rows.append(
            inventory.ActualInventoryRow(
                msku=str(row["MSKU"]),
                parent_asin=str(row["父ASIN"]),
                asin=str(row["ASIN"]),
                local_sku=str(row["本地SKU"]),
                product_link="",
                actual_inventory=Decimal("12") if row["MSKU"] == "SEA-1" else Decimal(0),
                child_skus=child_skus,
                binding_verified=verdicts[str(row["MSKU"])],
            )
        )
    inventory.write_actual_inventory_xlsx(inventory_rows, path)
    source_verification.stamp_report(path, source.metadata)
    return path


def _write_confirmed_empty_snapshot(directory: Path, *, snapshot_time: str = "202610131100") -> Path:
    query = shipments.StoreUnlinkedShipmentDownloadResult(
        store_name=STORE,
        store_id=401403,
        download_time="202610131000",
        status_results=[
            shipments.UnlinkedShipmentStatusResult(spec.status_name, 0)
            for spec in shipments.UNLINKED_SHIPMENT_STATUS_SPECS
        ],
    )
    return Path(
        shipments.build_store_unlinked_shipments_snapshot(
            [], store_name=STORE, query_result=query, snapshot_time=snapshot_time, output_dir=directory,
        ).snapshot_xlsx_path
    )


def _generate(tmp_path: Path, *, source_path: Path | None = None, inventory_path: Path | None = None,
              snapshot_path: Path | None = None, **generation_settings):
    source_path = source_path or _write_source(
        tmp_path / "202610131000-Amazon-Test_店铺MSKU数据.xlsx"
    )
    inventory_path = inventory_path or _write_inventory_report(
        tmp_path / "inventory.xlsx", source_path
    )
    snapshot_path = snapshot_path or _write_confirmed_empty_snapshot(tmp_path / "snapshots")
    return generate_replenishment_v2(
        STORE,
        msku_source_xlsx_path=source_path,
        shenzhen_inventory_report_xlsx_path=inventory_path,
        unlinked_shipments_snapshot_path=snapshot_path,
        output_dir=tmp_path / "out",
        **generation_settings,
    )


def test_workbook_preserves_literal_strings_and_only_writes_designed_formulas(tmp_path: Path) -> None:
    literals = {
        "店铺名称": "=store", "MSKU": "=msku", "父ASIN": "=parent", "ASIN": "=asin",
        "本地SKU名称": "=2+2", "备注": "=1+1", "本地SKU": "=local-sku",
    }
    path = tmp_path / "literal-text.xlsx"
    v2_workbook._write_workbook(path, [{**literals, "本地库存": -4, "单件重量(g)": 0}])
    book = load_workbook(path, data_only=False)
    try:
        sheet = book.active
        for header, expected in literals.items():
            cell = sheet.cell(2, v2_workbook.HEADERS.index(header) + 1)
            assert (cell.value, cell.data_type) == (expected, "s")
        assert sheet["AG2"].value == -4 and sheet["AG2"].data_type == "n"
        assert sheet["AD2"].value == 0 and sheet["AD2"].data_type == "n"
        assert {cell.column_letter for cell in sheet[2] if cell.data_type == "f"} == set(replenishment_v2_formulas(2))
    finally:
        book.close()


def test_verified_literal_text_survives_full_office_generation(tmp_path: Path) -> None:
    if not os.environ.get("LXE_OFFICE_NODE"):
        pytest.skip("LXE Office runtime is not configured; literal-text recalculation remains NOT VERIFIED")
    rows = _source_rows()[:3]
    rows[0].update({"本地SKU名称": "=2+2", "备注": "=1+1"})
    rows[1] = {**rows[0], "MSKU": "LITERAL-2", "本地SKU": "SKU-LITERAL-2",
               "本地SKU名称": "=UNKNOWN_SOURCE_TEXT(1)", "备注": "=UNICHAR(28165)&UNICHAR(36135)"}
    rows[2] = {**rows[0], "MSKU": "CONTROL-3", "本地SKU": "SKU-CONTROL-3", "本地SKU名称": "Control", "备注": ""}
    source = _write_source(tmp_path / "202610131000-Amazon-Test_店铺MSKU数据.xlsx", rows)
    verified = source_verification.load_verified_source(source, store_name=STORE)
    assert verified.records[0]["本地SKU名称"] == "=2+2"
    assert verified.records[0]["备注"] == "=1+1"
    report = _write_inventory_report(tmp_path / "inventory.xlsx", source, rows)
    snapshot = _write_confirmed_empty_snapshot(tmp_path / "snapshot")
    inputs = [source, report, snapshot]
    before = [hashlib.sha256(path.read_bytes()).hexdigest() for path in inputs]
    result = _generate(tmp_path, source_path=source, inventory_path=report, snapshot_path=snapshot)
    assert result.success is True
    assert result.unknown_inventory_count == 0
    assert result.formula_error_count == 0 and result.row_count == 3
    formulas = load_workbook(result.output_xlsx_path, data_only=False)
    values = load_workbook(result.output_xlsx_path, data_only=True)
    try:
        sheet, cached = formulas.active, values.active
        assert sheet.max_column == 35 and sheet.max_row == 4
        for number, row in enumerate(rows, 2):
            for column, header in (("AE", "本地SKU名称"), ("AF", "备注")):
                expected = row[header] or None
                assert sheet[f"{column}{number}"].value == expected
                assert sheet[f"{column}{number}"].data_type != "f"
                assert cached[f"{column}{number}"].value == expected
                if expected is not None:
                    assert sheet[f"{column}{number}"].data_type == cached[f"{column}{number}"].data_type == "s"
            expected_formulas = replenishment_v2_formulas(number, peak_boost_enabled=False)
            assert {cell.column_letter for cell in sheet[number] if cell.data_type == "f"} == set(expected_formulas)
            assert all(sheet[f"{column}{number}"].value == formula for column, formula in expected_formulas.items())
        # Literal UNICHAR text must not evaluate to 清货 and suppress the shipping-day formulas.
        for column in ("V", "W"):
            assert cached[f"{column}3"].value == cached[f"{column}4"].value
            assert cached[f"{column}3"].value is not None
        assert not any(cell.data_type == "e" for row in cached for cell in row)
    finally:
        formulas.close()
        values.close()
    assert [hashlib.sha256(path.read_bytes()).hexdigest() for path in inputs] == before


def test_unexpected_source_formula_after_office_stops_publication(tmp_path: Path, monkeypatch) -> None:
    if not os.environ.get("LXE_OFFICE_NODE"):
        pytest.skip("LXE Office runtime is not configured; formula trust-boundary check remains NOT VERIFIED")
    source = _write_source(tmp_path / "202610131000-Amazon-Test_店铺MSKU数据.xlsx")
    report = _write_inventory_report(tmp_path / "inventory.xlsx", source)
    snapshot = _write_confirmed_empty_snapshot(tmp_path / "snapshots")
    first = _generate(tmp_path, source_path=source, inventory_path=report, snapshot_path=snapshot)
    official = Path(first.output_xlsx_path)
    original_output = official.read_bytes()
    recalculate = v2_workbook._recalculate

    def inject_unexpected_formula(input_path: Path, output_path: Path) -> None:
        book = load_workbook(input_path)
        try:
            book.active["AE2"] = "=2+2"
            book.save(input_path)
        finally:
            book.close()
        recalculate(input_path, output_path)

    monkeypatch.setattr(v2_workbook, "_recalculate", inject_unexpected_formula)
    with pytest.raises(ReplenishmentV2WorkbookError, match="非计算单元格.*AE2"):
        _generate(tmp_path, source_path=source, inventory_path=report, snapshot_path=snapshot)
    assert official.read_bytes() == original_output


@pytest.mark.parametrize("initial_enabled,initial_days,next_enabled,next_days", [
    (False, 20, True, 40), (True, 20, True, 60), (True, 0, True, 10),
])
def test_generation_snapshots_setting_and_next_generation_reads_saved_value(
    tmp_path: Path, monkeypatch, initial_enabled, initial_days, next_enabled, next_days,
) -> None:
    settings.save_parameters({"peak_boost_enabled": initial_enabled, "peak_boost_days": initial_days})
    original_rows = v2_workbook._rows_for_workbook

    def change_setting_during_generation(*args, **kwargs):
        settings.save_parameters({"peak_boost_enabled": next_enabled, "peak_boost_days": next_days})
        return original_rows(*args, **kwargs)

    # This test checks the generation boundary; actual Office evaluation is tested separately.
    monkeypatch.setattr(v2_workbook, "_rows_for_workbook", change_setting_during_generation)
    monkeypatch.setattr(v2_workbook, "_recalculate", copyfile)
    monkeypatch.setattr(v2_workbook, "_inspect_recalculated", lambda *args, **kwargs: (0, ()))
    first = _generate(tmp_path / "first", peak_boost_enabled=True)
    second = _generate(tmp_path / "next", peak_boost_enabled=True)
    first_book = load_workbook(first.output_xlsx_path, data_only=False)
    second_book = load_workbook(second.output_xlsx_path, data_only=False)
    try:
        before, after = first_book.active, second_book.active
        assert before.max_column == after.max_column == 35
        assert before["AD1"].value == after["AD1"].value == "单件重量(g)"
        for row in range(2, 6):
            for column in range(1, 36):
                if column in (22, 23):
                    expected_first = replenishment_v2_formulas(row, peak_boost_enabled=True, peak_boost_days=initial_days)
                    expected_next = replenishment_v2_formulas(row, peak_boost_enabled=True, peak_boost_days=next_days)
                    assert before.cell(row, column).value == expected_first["V" if column == 22 else "W"]
                    assert after.cell(row, column).value == expected_next["V" if column == 22 else "W"]
                else:
                    assert before.cell(row, column).value == after.cell(row, column).value
        assert before["AG2"].value == after["AG2"].value == 12
        assert before["AH2"].value == after["AH2"].value == "SKU-SEA"
        for sheet in (before, after):
            assert all(sheet.cell(5, col).data_type == "f" for col in range(21, 30))
            assert all(sheet[f"{col}5"].data_type == "f" for col in ("I", "J", "R", "S"))
    finally:
        first_book.close()
        second_book.close()


def test_corrupt_setting_stops_before_reading_inputs_or_publishing(tmp_path: Path) -> None:
    settings.read_state()
    (settings.data_directory() / "parameters.json").write_text('{"peak_boost_enabled":0}', encoding="utf-8")
    with pytest.raises(ValueError, match="格式无效"):
        _generate(tmp_path)
    assert not (tmp_path / "out").exists()


@pytest.mark.parametrize("unbound_sales", [0, 7])
def test_generates_all_source_rows_without_formula_errors(tmp_path: Path, unbound_sales: int) -> None:
    if not os.environ.get("LXE_OFFICE_NODE"):
        pytest.skip("LXE Office runtime is not configured; recalculation remains NOT VERIFIED")
    source_rows = _source_rows()
    for column, days in (("7天销量", 7), ("14天销量", 14), ("30天销量", 30), ("90天销量", 90)):
        source_rows[3][column] = unbound_sales * days // 7
    source_path = _write_source(tmp_path / "202610131000-Amazon-Test_店铺MSKU数据.xlsx", source_rows)
    inventory_path = _write_inventory_report(tmp_path / "inventory.xlsx", source_path, source_rows)
    snapshot_path = _write_confirmed_empty_snapshot(tmp_path / "snapshots")
    # Moving an unchanged, verified source must preserve the report association.
    moved_source = tmp_path / "moved" / source_path.name
    moved_source.parent.mkdir()
    copyfile(source_path, moved_source)

    result = _generate(
        tmp_path,
        source_path=moved_source,
        inventory_path=inventory_path,
        snapshot_path=snapshot_path,
    )

    output_path = Path(result.output_xlsx_path)
    assert output_path.is_file()
    assert output_path.name.endswith(f"{STORE}补货最新-库存待核对.xlsx")
    assert result.row_count == 4
    assert result.success is False  # UNBOUND-1 remains in the workbook with blank AG.
    assert result.unknown_inventory_count == 1
    assert "UNBOUND-1" in result.unknown_inventory_examples[0]
    assert result.formula_error_count == 0
    assert result.formula_error_examples == ()

    formulas = load_workbook(output_path, data_only=False)
    values = load_workbook(output_path, data_only=True)
    try:
        assert formulas.sheetnames == ["mskulist"]
        sheet = formulas["mskulist"]
        cached = values["mskulist"]
        headers = [sheet.cell(1, column).value for column in range(1, 36)]
        assert headers == [
            "店铺名称", "MSKU", "父ASIN", "ASIN", "7天销量", "14天销量", "30天销量", "90天销量",
            "销量趋势", "加权日销", "可售", "待入库", "预留", "计划入库", "在途", "运营中心转运",
            "运营中心处理中", "FBA总库存（马帮）", "可销售天数", "未发出货件总计", "建议运输方式",
            "空运补货天数", "海运补货天数", "空运计划", "空运实际", "空运总重", "海运计划",
            "海运实际", "海运总重", "单件重量(g)", "本地SKU名称", "备注", "本地库存", "本地SKU", "可供天数",
        ]
        assert sheet.freeze_panes == "A2"
        assert sheet.auto_filter.ref == "A1:AI5"
        assert sheet.sheet_view.zoomScale == 85
        assert sheet["J2"].number_format == "0.0000"
        assert sheet["S2"].number_format == "0.00"
        assert all(sheet.cell(2, col).font.name == "Calibri" for col in range(1, 36))
        assert all(not sheet.cell(2, col).font.bold for col in range(1, 36))

        for row_number in range(2, 6):
            expected = replenishment_v2_formulas(row_number, peak_boost_enabled=False)
            assert {column: sheet[f"{column}{row_number}"].value for column in expected} == expected
        assert [sheet.cell(row, 2).value for row in range(2, 6)] == ["SEA-1", "CLEAR-1", "COMBO-1", "UNBOUND-1"]
        assert [sheet.cell(row, 1).value for row in range(2, 6)] == [STORE] * 4
        assert sheet["N2"].value == 17
        assert cached["T2"].value == 0
        assert sheet["AG3"].value == 0
        assert sheet["AG2"].value == 12
        assert sheet["AH3"].value == "SKU-CLEAR"
        assert sheet["AH4"].value == "SKU-COMBO"
        assert cached["J2"].value == pytest.approx(11)
        assert cached["R2"].value == pytest.approx(880)
        assert cached["S2"].value == pytest.approx(80)
        assert cached["AC2"].value == pytest.approx(cached["AB2"].value * cached["AD2"].value)
        assert cached["AC3"].value is None  # Clearance quantity is formula-empty.
        assert sheet["E5"].value == unbound_sales  # Keep the unbound row and its original sales.
        assert sheet["AH5"].value == "UNVERIFIED-LOCAL"
        for column in ("U", "V", "W", "X", "Y", "Z", "AA", "AB", "AC"):
            assert sheet[f"{column}5"].data_type == "f"
    finally:
        formulas.close()
        values.close()


@pytest.mark.parametrize("all_failed,blank_report_skus", [(False, False), (False, True), (True, False)])
def test_binding_verdict_is_preserved_without_suppressing_advice_after_office_recalculation(
    tmp_path: Path, all_failed: bool, blank_report_skus: bool,
) -> None:
    if not os.environ.get("LXE_OFFICE_NODE"):
        pytest.skip("LXE Office runtime is not configured; recalculation remains NOT VERIFIED")
    source_rows = _source_rows()
    source_rows.append({**source_rows[2], "MSKU": "UNMATCHED-1", "本地SKU": "UNKNOWN-LOCAL-SKU"})
    local_skus = (
        LocalSkuDefinition("SKU-SEA", 1),
        LocalSkuDefinition("SKU-CLEAR", 1),
        LocalSkuDefinition("SKU-COMBO", 2, (inventory.ComboComponent("SKU-CHILD", Decimal(2)),)),
        LocalSkuDefinition("UNVERIFIED-LOCAL", None),
        LocalSkuDefinition("UNKNOWN-LOCAL-SKU", None),
    )
    if all_failed:
        source_rows = source_rows[3:]
        local_skus = local_skus[-2:]
    source_path = _write_source(
        tmp_path / "202610131000-Amazon-Test_店铺MSKU数据.xlsx", source_rows,
        local_skus=local_skus,
    )
    verified = source_verification.load_verified_source(source_path, store_name=STORE)
    verdicts = {row["MSKU"]: row["是否通过绑定核验"] for row in verified.records}
    assert verdicts == (
        {"UNBOUND-1": False, "UNMATCHED-1": False} if all_failed else
        {"SEA-1": True, "CLEAR-1": True, "COMBO-1": True, "UNBOUND-1": False, "UNMATCHED-1": False}
    )
    report_path = _write_inventory_report(tmp_path / "inventory.xlsx", source_path, source_rows)
    if blank_report_skus:
        book = load_workbook(report_path)
        for ws in book.worksheets:
            if ws.title != source_verification.SHEET:
                headers = [c.value for c in ws[1]]
                for row_index in range(2, ws.max_row + 1):
                    ws.cell(row_index, headers.index("本地SKU") + 1).value = None
        book.save(report_path)
        book.close()
    result = _generate(tmp_path, source_path=source_path, inventory_path=report_path)
    assert result.success is False
    assert result.unknown_inventory_count == 2
    assert result.formula_error_count == 0
    assert result.row_count == len(source_rows)

    # Recalculate the delivered formulas again; blank caches alone must not hide advice.
    recalculated_again = tmp_path / "recalculated-again.xlsx"
    v2_workbook._recalculate(Path(result.output_xlsx_path), recalculated_again)
    for path in (Path(result.output_xlsx_path), recalculated_again):
        formulas = load_workbook(path, read_only=True, data_only=False)
        values = load_workbook(path, read_only=True, data_only=True)
        try:
            sheet, cached = formulas["mskulist"], values["mskulist"]
            assert sheet.max_row == len(source_rows) + 1 and sheet.max_column == 35
            for row_number, source_row in enumerate(source_rows, 2):
                msku = source_row["MSKU"]
                assert sheet[f"B{row_number}"].value == msku
                assert [sheet[f"{column}{row_number}"].value for column in ("E", "F", "G", "H")] == [
                    source_row[column] for column in ("7天销量", "14天销量", "30天销量", "90天销量")
                ]
                assert sheet[f"AG{row_number}"].value == (
                    12 if msku == "SEA-1" else None if msku in {"UNBOUND-1", "UNMATCHED-1"} else 0
                )
                assert sheet[f"AH{row_number}"].value == (source_row["本地SKU"] or None)
                expected = replenishment_v2_formulas(row_number, peak_boost_enabled=False)
                for column in ("I", "J", "R", "S"):
                    assert sheet[f"{column}{row_number}"].value == expected[column]
                assert cached[f"I{row_number}"].value is not None
                for column in ("U", "V", "W", "X", "Y", "Z", "AA", "AB", "AC"):
                    assert sheet[f"{column}{row_number}"].value == expected[column]
                if msku == "COMBO-1":
                    assert cached[f"U{row_number}"].value == "空运（急发）"
                    assert cached[f"Y{row_number}"].value == 50
        finally:
            formulas.close()
            values.close()


def test_workbook_layout_mapping_and_pr1_formulas_before_office(tmp_path: Path) -> None:
    source_path = _write_source(tmp_path / "202610131000-Amazon-Test_店铺MSKU数据.xlsx")
    report_path = _write_inventory_report(tmp_path / "inventory.xlsx", source_path)
    snapshot_path = _write_confirmed_empty_snapshot(tmp_path / "snapshots")
    verified = source_verification.load_verified_source(source_path, store_name=STORE)
    _, source_by_key = v2_workbook._unique_source_rows(verified.records)
    inventory_by_key = v2_workbook._load_shenzhen_rows(report_path, expected_keys=set(source_by_key))
    shipment_by_key = v2_workbook._shipment_quantities(
        snapshot_path, store_name=STORE, source_data_time="202610131000"
    )
    rows = v2_workbook._rows_for_workbook(
        verified.records,
        store_name=STORE,
        inventory_by_key=inventory_by_key,
        shipment_by_key=shipment_by_key,
    )
    workbook_path = tmp_path / "formulas.xlsx"
    v2_workbook._write_workbook(workbook_path, rows)

    workbook = load_workbook(workbook_path, data_only=False)
    try:
        assert workbook.sheetnames == ["mskulist"]
        sheet = workbook["mskulist"]
        assert sheet.max_column == 35
        assert sheet.max_row == len(verified.records) + 1
        assert tuple(sheet.cell(1, column).value for column in range(1, 36)) == (
            "店铺名称", "MSKU", "父ASIN", "ASIN", "7天销量", "14天销量", "30天销量", "90天销量",
            "销量趋势", "加权日销", "可售", "待入库", "预留", "计划入库", "在途", "运营中心转运",
            "运营中心处理中", "FBA总库存（马帮）", "可销售天数", "未发出货件总计", "建议运输方式",
            "空运补货天数", "海运补货天数", "空运计划", "空运实际", "空运总重", "海运计划",
            "海运实际", "海运总重", "单件重量(g)", "本地SKU名称", "备注", "本地库存", "本地SKU", "可供天数",
        )
        assert sheet["AH4"].value == "SKU-COMBO"
        assert sheet["AH3"].value == "SKU-CLEAR"
        assert sheet["AG3"].value == 0
        assert sheet["AG2"].value == 12
        assert sheet["N2"].value == 17
        assert sheet["T2"].value == 0
        assert sheet["AD2"].value == 50
        assert sheet.freeze_panes == "A2"
        assert sheet.auto_filter.ref == f"A1:AI{len(rows) + 1}"
        assert sheet.sheet_view.zoomScale == 85
        assert sheet["J2"].number_format == "0.0000"
        assert sheet["S2"].number_format == "0.00"
        assert all(sheet.cell(2, column).font.name == "Calibri" for column in range(1, 36))
        assert all(not sheet.cell(2, column).font.bold for column in range(1, 36))
        for row_number in range(2, len(rows) + 2):
            expected = replenishment_v2_formulas(row_number)
            actual = {
                column: sheet[f"{column}{row_number}"].value
                for column in expected
            }
            assert actual == expected
        assert all(sheet[f"{column}5"].data_type == "f" for column in ("U", "V", "W", "X", "Y", "Z", "AA", "AB", "AC", "AI"))
        assert [sheet.cell(row, 2).value for row in range(2, 6)] == ["SEA-1", "CLEAR-1", "COMBO-1", "UNBOUND-1"]
    finally:
        workbook.close()


@pytest.mark.parametrize("unbound_sales", [0, 7])
def test_unverified_rows_keep_source_data_with_all_formulas(
    tmp_path: Path, unbound_sales: int,
) -> None:
    source_rows = _source_rows()
    for column, days in (("7天销量", 7), ("14天销量", 14), ("30天销量", 30), ("90天销量", 90)):
        source_rows[3][column] = unbound_sales * days // 7
    source_path = _write_source(tmp_path / "202610131000-Amazon-Test_店铺MSKU数据.xlsx", source_rows)
    report_path = _write_inventory_report(tmp_path / "inventory.xlsx", source_path, source_rows)
    verified = source_verification.load_verified_source(source_path, store_name=STORE)
    _, source_by_key = v2_workbook._unique_source_rows(verified.records)
    mapped = v2_workbook._rows_for_workbook(
        verified.records,
        store_name=STORE,
        inventory_by_key=v2_workbook._load_shenzhen_rows(report_path, expected_keys=set(source_by_key)),
        shipment_by_key={},
    )
    workbook_path = tmp_path / "formulas.xlsx"
    v2_workbook._write_workbook(workbook_path, mapped)
    workbook = load_workbook(workbook_path, read_only=True, data_only=False)
    try:
        sheet = workbook["mskulist"]
        assert sheet.max_row == 5
        assert sheet.max_column == 35
        assert sheet["E5"].value == unbound_sales
        assert sheet["AH5"].value == "UNVERIFIED-LOCAL"
        assert all(sheet[f"{column}5"].data_type == "f" for column in ("U", "V", "W", "X", "Y", "Z", "AA", "AB", "AC", "AI"))
        for row_number in (2, 3, 4):
            assert {
                column: sheet[f"{column}{row_number}"].value
                for column in replenishment_v2_formulas(row_number)
            } == replenishment_v2_formulas(row_number)
        for column in ("I", "J", "R", "S"):
            assert sheet[f"{column}5"].value == replenishment_v2_formulas(5)[column]
    finally:
        workbook.close()


@pytest.mark.parametrize("mutation", ["store", "fingerprint"])
def test_source_store_and_fingerprint_are_verified(tmp_path: Path, mutation: str) -> None:
    source_path = _write_source(tmp_path / "202610131000-Amazon-Test_店铺MSKU数据.xlsx")
    inventory_path = _write_inventory_report(tmp_path / "inventory.xlsx", source_path)
    snapshot_path = _write_confirmed_empty_snapshot(tmp_path / "snapshots")
    if mutation == "fingerprint":
        workbook = load_workbook(source_path)
        workbook.active["I2"] = 78  # Change raw 7-day sales after source verification.
        workbook.save(source_path)
        workbook.close()
    diagnostic = "店铺不一致" if mutation == "store" else "发生变化"
    with pytest.raises(source_verification.SourceVerificationError, match=diagnostic):
        generate_replenishment_v2(
            "Wrong-Store" if mutation == "store" else STORE,
            msku_source_xlsx_path=source_path,
            shenzhen_inventory_report_xlsx_path=inventory_path,
            unlinked_shipments_snapshot_path=snapshot_path,
            output_dir=tmp_path / "out",
        )


@pytest.mark.parametrize("different_content", [True, False])
def test_inventory_report_must_have_the_same_source_batch(tmp_path: Path, different_content: bool) -> None:
    source_path = _write_source(tmp_path / "202610131000-Amazon-Test_店铺MSKU数据.xlsx")
    different_rows = _source_rows()
    if different_content:
        different_rows[0]["7天销量"] = 78
    other_source = _write_source(tmp_path / "other.xlsx", different_rows)
    source_metadata = source_verification.load_verified_source(source_path, store_name=STORE).metadata
    other_metadata = source_verification.load_verified_source(other_source, store_name=STORE).metadata
    assert source_metadata["snapshot_id"] != other_metadata["snapshot_id"]
    assert (source_metadata["source_fingerprint"] != other_metadata["source_fingerprint"]) is different_content
    report = _write_inventory_report(tmp_path / "inventory.xlsx", other_source)
    snapshot = _write_confirmed_empty_snapshot(tmp_path / "snapshots")

    with pytest.raises(ReplenishmentV2WorkbookError, match="批次"):
        _generate(
            tmp_path,
            source_path=source_path,
            inventory_path=report,
            snapshot_path=snapshot,
        )


def test_inventory_report_must_cover_every_source_msku(tmp_path: Path) -> None:
    source_path = _write_source(tmp_path / "202610131000-Amazon-Test_店铺MSKU数据.xlsx")
    report = _write_inventory_report(tmp_path / "inventory.xlsx", source_path, _source_rows()[:2])
    snapshot = _write_confirmed_empty_snapshot(tmp_path / "snapshots")

    with pytest.raises(ReplenishmentV2WorkbookError, match="覆盖与源表不一致"):
        _generate(tmp_path, source_path=source_path, inventory_path=report, snapshot_path=snapshot)


def test_inventory_report_rejects_duplicate_msku_across_sheets(tmp_path: Path, monkeypatch) -> None:
    source_path = _write_source(tmp_path / "202610131000-Amazon-Test_店铺MSKU数据.xlsx")
    report = _write_inventory_report(tmp_path / "inventory.xlsx", source_path)
    snapshot = _write_confirmed_empty_snapshot(tmp_path / "snapshots")
    workbook = load_workbook(report)
    try:
        stock_sheet = workbook[inventory.STOCK_ACTUAL_INVENTORY_SHEET]
        combo_sheet = workbook[inventory.COMBO_ACTUAL_INVENTORY_SHEET]
        headers = [cell.value for cell in stock_sheet[1]]
        assert [cell.value for cell in combo_sheet[1]] == headers
        msku_index = headers.index("MSKU")
        duplicate = next(list(row) for row in stock_sheet.iter_rows(min_row=2, values_only=True)
                         if row[msku_index] == "SEA-1")
        duplicate[headers.index(inventory.ACTUAL_INVENTORY_QUANTITY_COLUMN)] = 999
        combo_sheet.append(duplicate)
        assert stock_sheet.title != combo_sheet.title
        assert sum(row[msku_index] == "SEA-1" for sheet in (stock_sheet, combo_sheet)
                   for row in sheet.iter_rows(min_row=2, values_only=True)) == 2
        workbook.save(report)
    finally:
        workbook.close()

    write = Mock(side_effect=AssertionError("重复库存报告不得生成工作簿"))
    recalculate = Mock(side_effect=AssertionError("重复库存报告不得进入Office重算"))
    monkeypatch.setattr(v2_workbook, "_write_workbook", write)
    monkeypatch.setattr(v2_workbook, "_recalculate", recalculate)
    with pytest.raises(ReplenishmentV2WorkbookError, match="深圳库存报告存在重复 MSKU: 'SEA-1'"):
        _generate(tmp_path, source_path=source_path, inventory_path=report, snapshot_path=snapshot)
    write.assert_not_called()
    recalculate.assert_not_called()
    assert not list((tmp_path / "out").glob("*.xlsx"))


def test_ah_uses_report_local_sku_and_falls_back_to_source_when_blank(tmp_path: Path) -> None:
    source_path = _write_source(tmp_path / "202610131000-Amazon-Test_店铺MSKU数据.xlsx")
    report = _write_inventory_report(tmp_path / "inventory.xlsx", source_path)
    workbook = load_workbook(report)
    try:
        for sheet in workbook.worksheets:
            if sheet.title == source_verification.SHEET:
                continue
            headers = [cell.value for cell in sheet[1]]
            msku_column = headers.index("MSKU") + 1
            local_sku_column = headers.index("本地SKU") + 1
            for row_number in range(2, sheet.max_row + 1):
                msku = sheet.cell(row_number, msku_column).value
                if msku == "SEA-1":
                    sheet.cell(row_number, local_sku_column).value = " SKU-SEA "
                elif msku == "CLEAR-1":
                    sheet.cell(row_number, local_sku_column).value = None
        workbook.save(report)
    finally:
        workbook.close()

    source = source_verification.load_verified_source(source_path, store_name=STORE)
    _, source_by_key = v2_workbook._unique_source_rows(source.records)
    inventory_by_key = v2_workbook._load_shenzhen_rows(report, expected_keys=set(source_by_key))
    rows = v2_workbook._rows_for_workbook(
        source.records, store_name=STORE, inventory_by_key=inventory_by_key, shipment_by_key={},
    )
    assert [row["本地SKU"] for row in rows] == ["SKU-SEA", "SKU-CLEAR", "SKU-COMBO", "UNVERIFIED-LOCAL"]
    assert [row["本地库存"] for row in rows] == [12, 0, 0, None]


@pytest.mark.parametrize("msku,changed_sku", [
    ("SEA-1", "REPORT-SEA"),
    ("COMBO-1", "REPORT-COMBO"),
    ("UNBOUND-1", "REPORT-UNBOUND"),
])
def test_ah_accepts_report_local_sku_priority_after_source_verification(
    tmp_path: Path, msku: str, changed_sku: str,
) -> None:
    source_path = _write_source(tmp_path / "202610131000-Amazon-Test_店铺MSKU数据.xlsx")
    report = _write_inventory_report(tmp_path / "inventory.xlsx", source_path)
    workbook = load_workbook(report)
    try:
        for sheet in workbook.worksheets:
            if sheet.title == source_verification.SHEET:
                continue
            headers = [cell.value for cell in sheet[1]]
            msku_column = headers.index("MSKU") + 1
            local_sku_column = headers.index("本地SKU") + 1
            for row_number in range(2, sheet.max_row + 1):
                if sheet.cell(row_number, msku_column).value == msku:
                    sheet.cell(row_number, local_sku_column).value = changed_sku
        workbook.save(report)
    finally:
        workbook.close()

    source = source_verification.load_verified_source(source_path, store_name=STORE)
    _, source_by_key = v2_workbook._unique_source_rows(source.records)
    inventory_by_key = v2_workbook._load_shenzhen_rows(report, expected_keys=set(source_by_key))
    rows = v2_workbook._rows_for_workbook(
        source.records, store_name=STORE,
        inventory_by_key=inventory_by_key, shipment_by_key={},
    )
    assert next(row for row in rows if row["MSKU"] == msku)["本地SKU"] == changed_sku


def test_ag_preserves_negative_zero_and_numeric_text_from_shenzhen_report(tmp_path: Path) -> None:
    source_rows = _source_rows()
    source_path = _write_source(tmp_path / "202610131000-Amazon-Test_店铺MSKU数据.xlsx", source_rows)
    report = _write_inventory_report(tmp_path / "inventory.xlsx", source_path)
    workbook = load_workbook(report)
    for sheet in workbook.worksheets:
        if sheet.title in {source_verification.SHEET, inventory.NO_LOCAL_SKU_SHEET, inventory.NO_INVENTORY_DATA_SHEET}:
            continue
        headers = [cell.value for cell in sheet[1]]
        quantity_column = headers.index(inventory.ACTUAL_INVENTORY_QUANTITY_COLUMN) + 1
        msku_column = headers.index("MSKU") + 1
        for row_number in range(2, sheet.max_row + 1):
            msku = sheet.cell(row_number, msku_column).value
            if msku == "SEA-1": sheet.cell(row_number, quantity_column).value = -3
            elif msku == "CLEAR-1": sheet.cell(row_number, quantity_column).value = 0
            elif msku == "COMBO-1": sheet.cell(row_number, quantity_column).value = "2.5"
    workbook.save(report)
    workbook.close()
    verified = source_verification.load_verified_source(source_path, store_name=STORE)
    _, source_by_key = v2_workbook._unique_source_rows(verified.records)
    inventory_by_key = v2_workbook._load_shenzhen_rows(report, expected_keys=set(source_by_key))
    rows = v2_workbook._rows_for_workbook(
        verified.records, store_name=STORE, inventory_by_key=inventory_by_key,
        shipment_by_key={},
    )
    assert [row["本地库存"] for row in rows] == [-3, 0, 2.5, None]
    with pytest.raises(ReplenishmentV2WorkbookError, match="必须是有限非负数"):
        v2_workbook._optional_number(-1, context="未关联货件数量")


@pytest.mark.parametrize("invalid", ["NaN", "Infinity", True, "unknown"])
def test_ag_rejects_invalid_shenzhen_stock(tmp_path: Path, invalid) -> None:
    source_path = _write_source(tmp_path / "202610131000-Amazon-Test_店铺MSKU数据.xlsx")
    verified = source_verification.load_verified_source(source_path, store_name=STORE)
    report = _write_inventory_report(tmp_path / "inventory.xlsx", source_path)
    workbook = load_workbook(report)
    changed = False
    for sheet in workbook.worksheets:
        if sheet.title not in {source_verification.SHEET, inventory.NO_LOCAL_SKU_SHEET, inventory.NO_INVENTORY_DATA_SHEET}:
            headers = [cell.value for cell in sheet[1]]
            msku_column = headers.index("MSKU") + 1
            quantity_column = headers.index(inventory.ACTUAL_INVENTORY_QUANTITY_COLUMN) + 1
            for row_number in range(2, sheet.max_row + 1):
                if sheet.cell(row_number, msku_column).value == "SEA-1":
                    sheet.cell(row_number, quantity_column).value = invalid
                    changed = True
                    break
        if changed:
            break
    assert changed, "the invalid stock fixture must modify the existing SEA-1 report row"
    workbook.save(report)
    workbook.close()
    _, source_by_key = v2_workbook._unique_source_rows(verified.records)
    with pytest.raises(ReplenishmentV2WorkbookError, match="深圳库存报告 MSKU=SEA-1 库存"):
        v2_workbook._load_shenzhen_rows(report, expected_keys=set(source_by_key))


def test_inventory_report_real_quantity_is_the_ag_source(tmp_path: Path) -> None:
    source_path = _write_source(tmp_path / "202610131000-Amazon-Test_店铺MSKU数据.xlsx")
    report = _write_inventory_report(tmp_path / "inventory.xlsx", source_path)
    workbook = load_workbook(report, read_only=True)
    try:
        for sheet in workbook.worksheets:
            if sheet.title == source_verification.SHEET:
                continue
            headers = [cell.value for cell in sheet[1]]
            assert inventory.ACTUAL_INVENTORY_QUANTITY_COLUMN in headers
            assert "本地SKU" in headers
            assert "本地库存（仓位库存）" not in headers
    finally:
        workbook.close()
    verified = source_verification.load_verified_source(source_path, store_name=STORE)
    _, source_by_key = v2_workbook._unique_source_rows(verified.records)
    inventory_by_key = v2_workbook._load_shenzhen_rows(report, expected_keys=set(source_by_key))
    rows = v2_workbook._rows_for_workbook(
        verified.records, store_name=STORE, inventory_by_key=inventory_by_key,
        shipment_by_key={},
    )
    assert rows[0]["本地库存"] == 12
    assert rows[2]["本地SKU"] == "SKU-COMBO"


def test_source_without_native_local_inventory_is_accepted(tmp_path: Path) -> None:
    source_path = _write_source(tmp_path / "202610131000-Amazon-Test_店铺MSKU数据.xlsx")
    verified = source_verification.load_verified_source(source_path, store_name=STORE)
    assert len(v2_workbook._unique_source_rows(verified.records)[0]) == len(_source_rows())


@pytest.mark.parametrize("native_stock", [None, "", "NaN", "Infinity", True, "unknown"])
def test_unused_msku_local_inventory_does_not_validate_or_override_ag(tmp_path: Path, native_stock) -> None:
    source_rows = _source_rows()
    for row in source_rows:
        row["本地库存"] = native_stock
    source_path = _write_source(
        tmp_path / "202610131000-Amazon-Test_店铺MSKU数据.xlsx", source_rows,
        headers=(*SOURCE_HEADERS, "本地库存"),
    )
    verified = source_verification.load_verified_source(source_path, store_name=STORE)
    report = _write_inventory_report(tmp_path / "inventory.xlsx", source_path, source_rows)
    _, source_by_key = v2_workbook._unique_source_rows(verified.records)
    inventory_by_key = v2_workbook._load_shenzhen_rows(report, expected_keys=set(source_by_key))
    rows = v2_workbook._rows_for_workbook(
        verified.records, store_name=STORE, inventory_by_key=inventory_by_key, shipment_by_key={},
    )
    assert [row["本地库存"] for row in rows] == [12, 0, 0, None]


def test_duplicate_source_msku_is_rejected(tmp_path: Path) -> None:
    rows = _source_rows()
    rows[1]["MSKU"] = rows[0]["MSKU"]
    source_path = _write_source(tmp_path / "202610131000-Amazon-Test_店铺MSKU数据.xlsx", rows)
    report = _write_inventory_report(tmp_path / "inventory.xlsx", source_path, rows)
    snapshot = _write_confirmed_empty_snapshot(tmp_path / "snapshots")

    with pytest.raises(ReplenishmentV2WorkbookError, match="重复 MSKU"):
        _generate(tmp_path, source_path=source_path, inventory_path=report, snapshot_path=snapshot)


def test_missing_required_source_number_is_not_converted_to_zero(tmp_path: Path) -> None:
    rows = _source_rows()
    rows[0]["可售"] = None
    source_path = _write_source(tmp_path / "202610131000-Amazon-Test_店铺MSKU数据.xlsx", rows)
    report = _write_inventory_report(tmp_path / "inventory.xlsx", source_path, rows)
    snapshot = _write_confirmed_empty_snapshot(tmp_path / "snapshots")

    with pytest.raises(ReplenishmentV2WorkbookError, match="可售"):
        _generate(tmp_path, source_path=source_path, inventory_path=report, snapshot_path=snapshot)


def test_explicit_zero_weight_is_preserved_without_accepting_invalid_weight(tmp_path: Path) -> None:
    rows = _source_rows()
    rows[0]["单品重量(g)(cm)"] = 0
    source_path = _write_source(tmp_path / "202610131000-Amazon-Test_店铺MSKU数据.xlsx", rows)
    report = _write_inventory_report(tmp_path / "inventory.xlsx", source_path, rows)
    verified = source_verification.load_verified_source(source_path, store_name=STORE)
    _, source_by_key = v2_workbook._unique_source_rows(verified.records)
    mapped = v2_workbook._rows_for_workbook(
        verified.records, store_name=STORE,
        inventory_by_key=v2_workbook._load_shenzhen_rows(report, expected_keys=set(source_by_key)),
        shipment_by_key={},
    )
    assert mapped[0]["单件重量(g)"] == 0
    rows[0]["单品重量(g)(cm)"] = "invalid"
    with pytest.raises(ReplenishmentV2WorkbookError, match="AD重量解析.*MSKU=SEA-1.*无法解析"):
        v2_workbook._rows_for_workbook(
            rows, store_name=STORE,
            inventory_by_key=v2_workbook._load_shenzhen_rows(report, expected_keys=set(source_by_key)),
            shipment_by_key={},
        )


def test_snapshot_quantities_map_by_msku_and_orphans_are_rejected(tmp_path: Path) -> None:
    source_path = _write_source(tmp_path / "202610131000-Amazon-Test_店铺MSKU数据.xlsx")
    source = source_verification.load_verified_source(source_path, store_name=STORE)
    _, source_by_key = v2_workbook._unique_source_rows(source.records)
    report = _write_inventory_report(tmp_path / "inventory.xlsx", source_path)
    inventory_by_key = v2_workbook._load_shenzhen_rows(report, expected_keys=set(source_by_key))

    rows = v2_workbook._rows_for_workbook(
        source.records,
        store_name=STORE,
        inventory_by_key=inventory_by_key,
        shipment_by_key={"SEA-1": 3.5},
    )
    assert rows[0]["未发出货件总计"] == 3.5
    with pytest.raises(ReplenishmentV2WorkbookError, match="源表没有的 MSKU"):
        v2_workbook._rows_for_workbook(
            source.records,
            store_name=STORE,
            inventory_by_key=inventory_by_key,
            shipment_by_key={"ORPHAN": 1},
        )


def test_snapshot_from_a_different_day_is_rejected(tmp_path: Path) -> None:
    source_path = _write_source(tmp_path / "202610131000-Amazon-Test_店铺MSKU数据.xlsx")
    report = _write_inventory_report(tmp_path / "inventory.xlsx", source_path)
    snapshot = _write_confirmed_empty_snapshot(tmp_path / "snapshots", snapshot_time="202610121100")

    with pytest.raises(StoreMskuReplenishmentError, match="日期与备货数据日期不一致"):
        _generate(tmp_path, source_path=source_path, inventory_path=report, snapshot_path=snapshot)


def test_office_failure_preserves_real_diagnostic(monkeypatch, tmp_path: Path) -> None:
    def fail(arguments, *, timeout_seconds):
        assert arguments[0] == "recalculate"
        assert timeout_seconds == v2_workbook.OFFICE_TIMEOUT_SECONDS
        return subprocess.CompletedProcess(arguments, 1, "", "LXE_OFFICE_NODE is not configured")

    monkeypatch.setattr(v2_workbook, "run_kit_bounded", fail)
    with pytest.raises(ReplenishmentV2WorkbookError, match="LXE_OFFICE_NODE is not configured"):
        v2_workbook._recalculate(tmp_path / "in.xlsx", tmp_path / "out.xlsx")


def test_formula_error_does_not_replace_same_day_successful_output(monkeypatch, tmp_path: Path) -> None:
    source_rows = _source_rows()[:3]
    source = _write_source(tmp_path / "202610131000-Amazon-Test_店铺MSKU数据.xlsx", source_rows)
    report = _write_inventory_report(tmp_path / "inventory.xlsx", source, source_rows)
    snapshot = _write_confirmed_empty_snapshot(tmp_path / "snapshots")
    recalculation_count = 0

    def recalculate_with_distinct_valid_xlsx(input_path: Path, output_path: Path) -> None:
        nonlocal recalculation_count
        recalculation_count += 1
        workbook = load_workbook(input_path)
        try:
            workbook.properties.description = f"publication-test-{recalculation_count}"
            workbook.save(output_path)
        finally:
            workbook.close()

    inspections = iter([(0, ()), (1, ("AC3=#VALUE!",))])
    monkeypatch.setattr(v2_workbook, "_recalculate", recalculate_with_distinct_valid_xlsx)
    monkeypatch.setattr(
        v2_workbook, "_inspect_recalculated",
        lambda path, *, rows: next(inspections),
    )
    first = _generate(tmp_path, source_path=source, inventory_path=report, snapshot_path=snapshot)
    official_path = Path(first.output_xlsx_path)
    official_bytes = official_path.read_bytes()
    assert first.success

    second = _generate(tmp_path, source_path=source, inventory_path=report, snapshot_path=snapshot)
    diagnostic_path = Path(second.output_xlsx_path)
    assert not second.success
    assert second.formula_error_examples == ("AC3=#VALUE!",)
    assert diagnostic_path.is_file() and diagnostic_path != official_path
    assert official_path.read_bytes() == official_bytes
    assert diagnostic_path.read_bytes() != official_bytes
