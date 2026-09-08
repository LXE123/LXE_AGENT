from __future__ import annotations

from dataclasses import replace
from copy import deepcopy
from pathlib import Path
from zipfile import ZipFile
from xml.etree import ElementTree as ET

import pytest
from openpyxl import load_workbook

from services.mabang.amazon.fba import replenishment_formula_sheet as formulas
from services.mabang.amazon.fba import replenishment_template as templates
from services.mabang.amazon.fba import store_msku_replenishment as rep
from test_mabang_store_msku_replenishment import _inventory_input_row, _write_sales_report


def case_row(msku="ITEM", *, daily=6, fba=430, unlinked=10, weight=100, template_name="test-companion"):
    values = {key: 0.0 for key in formulas.SOURCE_VALUE_COLUMNS}
    values.update({"7天销量": daily * 7, "14天销量": daily * 14, "30天销量": daily * 30,
                   "90天销量": daily * 90, "可售": fba, "计划入库": 1000})
    inventory = replace(_inventory_input_row(msku, fba_total_inventory=fba), actual_inventory=100,
                        remark="整箱包装", product_name="产品", local_sku_name="本地名")
    detail = rep.SalesDetail("平稳", weight, daily * 7, daily * 14, daily * 30, source_values=values)
    template = templates.get_template("2组-US站点-林美淇" if template_name == "test-companion" else template_name)
    if template_name == "test-companion":
        params = deepcopy(template.params)
        params["shipping"]["air_sales_days_lte"] = 70
        template = replace(template, name="test-companion", params=params)
    return rep.calculate_replenishment_rows(
        [inventory], {(msku, inventory.parent_asin, inventory.asin, inventory.local_sku): detail},
        template, {msku: unlinked},
    )[0]


def test_formulas_cached_initial_values_and_metadata(tmp_path):
    from mabang_test_helpers import _stamp_active_test_report
    from services.mabang.amazon.fba.active_msku_source import _read_info

    rows = [case_row("SEA"), case_row("AIR", fba=300, unlinked=20, template_name="默认"),
            case_row("URGENT", daily=3, fba=90, unlinked=0, weight=None, template_name="默认"),
            case_row("SEA-ONLY", fba=480, unlinked=0, weight=1, template_name="默认")]
    rows.append(replace(rows[0], msku="NO-SHIP", non_shipping_reason_code="sea_daily_threshold", non_shipping_reason_detail="fixture: sea daily threshold", sheet_name=rep.NO_SHIP_SHEET))
    rows.append(replace(rows[0], msku="CLEARANCE", non_shipping_reason_code="clearance", non_shipping_reason_detail="商品备注含‘清货’，本轮不安排备货", sheet_name=rep.CLEARANCE_SHEET))
    rows.append(replace(rows[0], msku="SAMPLE", non_shipping_reason_code="parameter_skip", non_shipping_reason_detail="fixture: skipped trend", sheet_name=rep.SAMPLE_INSUFFICIENT_SHEET, replenish_quantity=None))
    source = _write_sales_report(tmp_path / "202605251530-Amazon-Test_销量分析.xlsx")
    wb = load_workbook(source)
    metadata, _ = _read_info(wb)
    wb.close()
    path = rep.write_replenishment_report(rows, tmp_path / "result.xlsx", active_metadata=metadata, missing_unlinked_snapshot=True)
    book = load_workbook(path, data_only=True)
    raw = load_workbook(path, data_only=False)
    try:
        sheet = book[formulas.FINAL_SHIPPING_SHEET]
        records = list(sheet.iter_rows(min_row=3, values_only=True))
        assert [r[0] for r in records] == ["URGENT", "AIR", "SEA", "SEA-ONLY"]
        assert [(r[22], r[23]) for r in records] == [(90, 0), (130, 0), (10, 210), (0, 60)]
        assert [r[25] for r in records] == [None, 13, 22, 0.06]
        assert all(r[12] == 1000 for r in records)  # Planned inbound never enters FBA deduction.
        assert records[2][16] == 430
        assert records[2][17] == 10
        assert "缺口120件" in records[2][26]
        assert "未取得同日未关联货件快照" in records[2][26]
        assert "单件重量缺失" in records[0][26]
        assert book[formulas.FORMULA_PARAMS_SHEET].sheet_state == "hidden"
        assert _read_info(book)[0] == metadata
        assert raw.calculation.calcMode == "auto"
        assert raw.active.title == formulas.FINAL_SHIPPING_SHEET
        assert raw.active.freeze_panes == "E3"
        assert raw.active.tables["FinalShipping"].ref == "A2:AC6"
        assert raw.active.tables["FinalShipping"].autoFilter.ref == "A2:AC6"
        assert raw.active.auto_filter.ref is None
        assert raw.active.column_dimensions["AC"].hidden
        assert [c.value for c in raw.active[2]][:28] == list(formulas.FINAL_SHIPPING_COLUMNS)
        for address in ("I3", "Q3", "W3", "X3", "Z3", "AA3"):
            assert raw.active[address].data_type == "f"
        assert raw.active["E3"].fill != raw.active["W3"].fill
        for ws in raw:
            for cells in ws:
                for cell in cells:
                    if cell.data_type == "f":
                        assert len(cell.value) < 8192
        assert len(raw.active.data_validations.dataValidation) == 2
    finally:
        book.close()
        raw.close()
    with ZipFile(path) as archive:
        assert archive.testzip() is None
        ns = {"s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
        worksheet = ET.fromstring(archive.read("xl/worksheets/sheet1.xml"))
        table = ET.fromstring(archive.read("xl/tables/table1.xml"))
        # Check the final package after Active metadata and cache injection:
        # Excel repairs/removes this table if a sheet-level filter overlaps it.
        assert worksheet.find("s:autoFilter", ns) is None
        assert table.find("s:autoFilter", ns).attrib["ref"] == "A2:AC6"
        assert len(worksheet.findall("s:tableParts/s:tablePart", ns)) == 1


def test_empty_shipping_sheet_retains_instruction_and_headers(tmp_path):
    path = rep.write_replenishment_report([], tmp_path / "empty.xlsx")
    book = load_workbook(path)
    try:
        assert book.active.max_row == 2
        assert not book.active.tables
        assert book.active.auto_filter.ref == "A2:AC2"
    finally:
        book.close()


def test_weighted_sales_integer_boundary_uses_formal_evaluation_order(tmp_path):
    # YYH-US regression: sum() produced 184.00000000000003 before ceil,
    # while the formal left-associative calculation produced exactly 184.
    inventory = _inventory_input_row("CEIL-BOUNDARY", fba_total_inventory=82)
    values = dict.fromkeys(formulas.SOURCE_VALUE_COLUMNS, 0.0)
    values.update({"7天销量": 18.0, "14天销量": 33.0, "30天销量": 61.0,
                   "90天销量": 181.0, "可售": 31.0, "预留": 2.0,
                   "在途": 45.0, "待调仓": 2.0, "调仓中": 2.0})
    detail = rep.SalesDetail("增长", 100, 18, 33, 61, source_values=values)
    key = (inventory.msku, inventory.parent_asin, inventory.asin, inventory.local_sku)
    row = rep.calculate_replenishment_rows([inventory], {key: detail}, templates.load_default_template())[0]
    assert row.replenish_days == 75
    assert row.replenish_quantity == 102
    path = rep.write_replenishment_report([row], tmp_path / "boundary.xlsx")
    book = load_workbook(path, data_only=True)
    try:
        assert book[formulas.FINAL_SHIPPING_SHEET]["I3"].value == row.weighted_daily_sales
        assert book[formulas.FINAL_SHIPPING_SHEET]["W3"].value == 102
        assert book[formulas.FINAL_SHIPPING_SHEET]["X3"].value == 0
        assert book[formulas.FORMULA_PARAMS_SHEET]["J2"].value == 184
        assert not {rep.AIR_URGENT_SHEET, rep.AIR_SHEET, rep.SEA_SHEET} & set(book.sheetnames)
    finally:
        book.close()


@pytest.mark.parametrize("value", [None, "", "unknown", "NaN", float("inf"), -1, True])
def test_source_values_are_not_silently_zeroed(tmp_path, value):
    path = _write_sales_report(tmp_path / "source.xlsx")
    book = load_workbook(path)
    sheet = book["MSKU明细"]
    column = [cell.value for cell in sheet[1]].index("待调仓") + 1
    sheet.cell(2, column, value)
    if value is None:
        sheet.cell(2, column).value = None
    book.save(path)
    book.close()
    with pytest.raises(ValueError, match="备货公式输入无效"):
        rep.load_sales_details(path)


def test_load_source_columns_and_detect_missing_columns(tmp_path):
    path = _write_sales_report(tmp_path / "source.xlsx")
    details = rep.load_sales_details(path)
    first = next(iter(details.values()))
    assert first.source_values["90天销量"] == 540
    assert first.source_values["待调仓"] == 0.0
    book = load_workbook(path)
    sheet = book["MSKU明细"]
    sheet.delete_cols([c.value for c in sheet[1]].index("90天销量") + 1)
    book.save(path)
    book.close()
    with pytest.raises(ValueError, match="90天销量"):
        rep.load_sales_details(path)


def test_source_stock_total_must_match_inventory_report(tmp_path):
    path = _write_sales_report(tmp_path / "source.xlsx")
    details = rep.load_sales_details(path)
    row = replace(_inventory_input_row("SEA-1", fba_total_inventory=999), parent_asin="PARENT-SEA", asin="ASIN-SEA", local_sku="COMBO-SEA")
    with pytest.raises(ValueError, match="库存分项与真实库存报表不一致"):
        rep.calculate_replenishment_rows([row], details)


@pytest.mark.parametrize("weight", [None, 0.01, 1, 100000])
def test_sea_decision_and_minimum_quantity_independent_of_weight(weight):
    row = case_row(weight=weight, fba=600, unlinked=0)
    assert row.sheet_name == rep.SEA_SHEET
    assert row.sea_quantity == 60
    below = case_row(weight=weight, fba=600, unlinked=31)
    assert below.sheet_name == rep.NO_SHIP_SHEET
    assert "海运数量不足30件" in below.decision_reason


def test_legacy_weight_parameters_are_ignored_on_xlsx_import(tmp_path):
    path = templates.export_template_xlsx("默认", output_dir=tmp_path)
    book = load_workbook(path)
    sea = book["海运进入条件"]
    sea.insert_rows(5)
    sea.cell(5, 1, "海运最低重量kg")
    sea.cell(5, 2, 100000)
    special = book["特殊MSKU规则"]
    special.insert_cols(9)
    special.cell(1, 9, "海运最低重量kg")
    book.save(path)
    book.close()
    parsed = templates.validate_template_xlsx(path)
    assert "min_weight_kg" not in parsed.template.params["sea"]
    assert templates.validate_template(parsed.template)


def test_fractional_deductions_keep_each_rounding_stage(tmp_path):
    row = case_row(fba=300.2, unlinked=0.4, template_name="默认")
    assert row.replenish_quantity == 150
    path = rep.write_replenishment_report([row], tmp_path / "rounding.xlsx")
    book = load_workbook(path, data_only=True)
    try:
        assert book.active["W3"].value == 150
    finally:
        book.close()


def test_zero_sea_component_is_not_replaced_with_total_quantity():
    row = replace(case_row(), original_replenish_quantity=450, replenish_quantity=450,
                  companion_air_quantity=450, sea_quantity=0, sea_net_quantity=0,
                  fba_total_inventory=430, unlinked_quantity=0)
    result = rep._with_inventory_deductions(row, min_sea_quantity=30)
    assert result.sheet_name == rep.NO_SHIP_SHEET
    assert result.sea_quantity == 0
    assert result.companion_air_quantity == 20


def test_formula_uses_effective_special_weights_with_nonuniform_sales(tmp_path):
    template = templates.get_template("默认")
    params = deepcopy(template.params)
    params["special_rules"] = [{"rule_name": "实际权重", "msku_list": ["SPECIAL"],
                               "overrides": {"weighted_sales": {"7d_weight": 0.1, "14d_weight": 0.2, "30d_weight": 0.7}}}]
    inventory = _inventory_input_row("SPECIAL", fba_total_inventory=0)
    values = dict.fromkeys(formulas.SOURCE_VALUE_COLUMNS, 0.0)
    values.update({"7天销量": 7, "14天销量": 28, "30天销量": 90, "90天销量": 999})
    detail = rep.SalesDetail("平稳", None, 7, 28, 90, source_values=values)
    row = rep.calculate_replenishment_rows([inventory], {rep._row_key(inventory): detail}, replace(template, params=params))[0]
    assert row.formula_inputs.weights == (0.1, 0.2, 0.7)
    path = rep.write_replenishment_report([row], tmp_path / "special.xlsx")
    book = load_workbook(path, data_only=True)
    try:
        assert book.active["I3"].value == pytest.approx(2.6)
        assert book.active["W3"].value == row.replenish_quantity
        assert book.active["H3"].value == 999
    finally:
        book.close()


@pytest.mark.parametrize('stock,expected', [(None,None), (-5,135), (0,130), (10.5,119.5), (130,0), (1000,0)])
def test_stock_gap_column_cached_and_sort_keys_preserved(tmp_path, stock, expected):
    row=replace(case_row('GAP', fba=300, unlinked=20, template_name='默认'),actual_inventory=stock)
    path=rep.write_replenishment_report([row],tmp_path/'gap.xlsx')
    book=load_workbook(path,data_only=True);raw=load_workbook(path)
    try:
        assert book.active['AB2'].value=='深圳库存缺口'
        assert book.active['AB3'].value==expected
        assert book.active['W3'].value==130 and book.active['X3'].value==0
        assert book.active['AC3'].value=='record-2'
        assert raw.active['AB3'].data_type=='f'
        assert 'COUNT(S3,W3:X3)=3' in raw.active['AB3'].value
        assert raw.active.column_dimensions['AC'].hidden
        assert not raw.active.column_dimensions['AB'].hidden
        assert raw.active['AB3'].fill.fgColor.rgb==raw.active['W3'].fill.fgColor.rgb=='00EAF2F8'
        assert raw.active['AB3'].fill.patternType=='solid'
        assert raw.active.tables['FinalShipping'].ref=='A2:AC3'
        assert '$AC3' in raw.active['W3'].value
        assert '$AC$3:$AC$3' in raw['备货公式参数']['J2'].value
    finally:book.close();raw.close()
