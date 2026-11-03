from copy import deepcopy
from dataclasses import replace

import pytest
from openpyxl import load_workbook

from services.mabang.amazon.fba import store_msku_replenishment as rep
from services.mabang.amazon.fba import replenishment_template as templates
from test_mabang_store_msku_replenishment import _inventory_input_row
from test_replenishment_formula_sheet import case_row
from test_replenishment_sample_sheet import sample_row


def decide(*, daily=6, fba=480, sea_changes=None, trend='平稳', unlinked=0):
    template = templates.load_default_template()
    params = deepcopy(template.params)
    params['sea'].update(sea_changes or {})
    template = replace(template, name='生效方案', params=params)
    values = dict.fromkeys(rep.SOURCE_VALUE_COLUMNS, 0)
    values.update({'7天销量': daily*7, '14天销量': daily*14, '30天销量': daily*30,
                   '90天销量': daily*90, '可售': fba})
    inv = _inventory_input_row('CHECK', fba_total_inventory=fba)
    detail = rep.SalesDetail(trend, None, daily*7, daily*14, daily*30, source_values=values)
    return rep.calculate_replenishment_rows([inv], {(inv.msku,inv.parent_asin,inv.asin,inv.local_sku):detail},
                                            template, {'CHECK':unlinked})[0]


@pytest.mark.parametrize('options,code', [
    ({'daily':1,'fba':60}, 'fba_covered'),
    ({'daily':1,'fba':30,'unlinked':20}, 'inventory_shipments_covered'),
    ({'daily':0,'fba':1}, 'zero_daily_sales'),
    ({'sea_changes':{'enabled':False}}, 'sea_disabled'),
    ({'daily':4,'fba':400}, 'sea_daily_threshold'),
    ({'daily':4,'fba':400,'sea_changes':{'min_daily_sales':7,'min_daily_sales_inclusive':True}},
     'sea_daily_threshold'),
    ({'sea_changes':{'tiers':[]}}, 'sea_tier_missing'),
    ({'sea_changes':{'companion_air_enabled':True,'companion_air_tiers':[]}},
     'sea_tier_missing'),
])
def test_reason_code_from_actual_branch(options, code):
    row = decide(**options)
    assert row.sheet_name == rep.NO_SHIP_SHEET
    assert row.non_shipping_reason_code == code
    payload = rep._non_shipping_payload(row)
    assert payload['未备货原因分类'] == rep.NON_SHIPPING_REASONS[code]
    # Rendering must not parse the legacy diagnostic string.
    assert rep._non_shipping_payload(replace(row, decision_reason='unrelated 401/403 text')) == payload


def test_sea_minimum_and_zero_days_remain_actual_decisions():
    row = case_row(fba=600, unlinked=31)
    assert row.replenish_quantity == 29
    assert row.non_shipping_reason_code == 'sea_quantity_threshold'
    assert rep._non_shipping_payload(decide(daily=0,fba=1))['可销售天数'] is None


def test_merge_preserves_records_and_sorts_on_daily_sales(tmp_path):
    rows = [replace(sample_row(), msku='A'), replace(decide(daily=4,fba=400), msku='HIGH'),
            replace(decide(daily=1,fba=60), msku='SAME',asin='B'),
            replace(decide(daily=1,fba=60), msku='SAME',asin='A')]
    path = rep.write_replenishment_report(rows, tmp_path/'merged.xlsx')
    book = load_workbook(path)
    try:
        assert rep.NO_SHIP_SHEET not in book.sheetnames and rep.SAMPLE_INSUFFICIENT_SHEET not in book.sheetnames
        assert book.sheetnames == ['最终备货意见','本轮不备货','链接备货汇总']
        sheet = book[rep.NON_SHIPPING_SHEET]
        data = list(sheet.iter_rows(min_row=3, values_only=True))
        assert [(r[0],r[1]) for r in data] == [('HIGH','ASIN-CHECK'),('SAME','A'),('SAME','B'),('A','ASIN-LOW')]
        assert len(data)==4 and sheet.max_column==39
        assert sheet.auto_filter.ref == 'A2:AM6'
        assert sheet.freeze_panes == 'E3'
        assert {r[-2] for r in data} == {'样本不足','未达海运日销门槛','FBA库存已覆盖'}
        assert sheet['T3'].number_format=='0.00'
    finally:book.close()


def test_empty_merged_sheet_keeps_aligned_headers(tmp_path):
    book = load_workbook(rep.write_replenishment_report([], tmp_path/'empty.xlsx'))
    try:
        sheet=book[rep.NON_SHIPPING_SHEET]
        assert sheet.max_row==2
        assert [c.value for c in sheet[2]][:-2]==[c.value for c in book['最终备货意见'][2]]
        assert sheet.auto_filter.ref=='A2:AM2'
    finally:book.close()


@pytest.mark.parametrize('code,detail', [('', 'reason'), ('unknown', 'reason'), ('fba_covered','')])
def test_missing_structured_reason_blocks_publication(tmp_path, code, detail):
    path=tmp_path/'report.xlsx';path.write_bytes(b'previous')
    row=replace(decide(daily=1,fba=60), non_shipping_reason_code=code, non_shipping_reason_detail=detail)
    with pytest.raises(rep.StoreMskuReplenishmentError, match='缺少有效原因'):
        rep.write_replenishment_report([row],path)
    assert path.read_bytes()==b'previous'
    assert list(tmp_path.iterdir())==[path]


def test_clearance_merges_without_broadening_classification(tmp_path):
    clear=rep._with_clearance_split(replace(case_row('CLEAR'),remark='一般清货'))
    low=rep._with_clearance_split(replace(sample_row(),remark='一般清货'))
    no_ship=rep._with_clearance_split(replace(decide(daily=1,fba=60),remark='一般清货'))
    assert clear.sheet_name==rep.CLEARANCE_SHEET
    assert clear.non_shipping_reason_code=='clearance'
    assert low.non_shipping_reason_code=='low_sample'
    assert no_ship.non_shipping_reason_code=='fba_covered'
    book=load_workbook(rep.write_replenishment_report([clear,low,no_ship],tmp_path/'clear.xlsx'),data_only=True)
    try:
        assert book.sheetnames==['最终备货意见','本轮不备货','链接备货汇总']
        it=book[rep.NON_SHIPPING_SHEET].iter_rows(min_row=2,values_only=True);h=next(it);rows=[dict(zip(h,r)) for r in it]
        assert len(rows)==3
        assert {r['未备货原因分类'] for r in rows}=={'清货','样本不足','FBA库存已覆盖'}
        row=next(r for r in rows if r['MSKU']=='CLEAR')
        assert row['备注']=='一般清货'
        assert clear.replenish_quantity > 0
        assert all((r['空运建议量'],r['海运建议量'])==(0,0) for r in rows)
        assert book['最终备货意见'].max_row==2
    finally:book.close()


def test_aligned_columns_preserve_source_values_and_snapshot_decision(tmp_path):
    row = decide(daily=1, fba=60, unlinked=7)
    values = {**row.formula_inputs.values, '可售':10, '待入库':11, '预留':12,
              '计划入库':999, '在途':8, '待调仓':9, '调仓中':10}
    row = replace(row, local_sku_name='=2+2', actual_inventory=-86, weight_grams=250,
                  formula_inputs=replace(row.formula_inputs, values=values))
    path = rep.write_replenishment_report([case_row('SHIP'), row], tmp_path/'aligned.xlsx')
    book = load_workbook(path, data_only=True)
    try:
        shipping, excluded = book['最终备货意见'], book['本轮不备货']
        headers = [c.value for c in excluded[2]]
        assert headers[:-2] == [c.value for c in shipping[2]]
        assert headers[-2:] == ['未备货原因分类', '具体原因']
        record = dict(zip(headers, (c.value for c in excluded[3])))
        assert record['品名'] == '=2+2'
        assert [record[k] for k in ('7天销量','14天销量','30天销量','90天销量')] == [7,14,30,90]
        assert [record[k] for k in ('可售','待入库','预留','计划入库','在途','待调仓','调仓中')] == [10,11,12,999,8,9,10]
        assert [record[k] for k in ('加权日销','FBA总库存（马帮）','未发出货件总计','深圳可用库存','可销售天数','单件重量(g)')] == pytest.approx([1,60,7,-86,60,250])
        assert (record['空运建议量'],record['海运建议量']) == (0,0)
        assert record['建议运输方式（生成时）'] == '本轮不备货'
        assert record['未备货原因分类'] == 'FBA库存已覆盖'
        assert 'FBA库存60件已覆盖' in record['具体原因']
        assert record['理论空运需求'] is None
        assert record['理论海运需求'] is None
        assert shipping['AD3'].value == 10 and shipping['AE3'].value == 210
    finally:book.close()
