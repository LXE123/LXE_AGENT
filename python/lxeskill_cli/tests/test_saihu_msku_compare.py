import sys
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parents[3] / 'scripts'
sys.path.insert(0, str(SCRIPTS))
from source_comparison_helpers import quantity, keyed, redact
from analyze_saihu_msku_compare import sales_rows


@pytest.mark.parametrize('v',[None,''])
def test_missing_is_not_zero(v):
    assert quantity(v) is None
    assert quantity('0') == 0


@pytest.mark.parametrize('v',['NaN','Infinity',-1,True])
def test_invalid_quantities(v):
    with pytest.raises(ValueError): quantity(v)


def test_duplicate_conflicts():
    a=dict(msku='a',asin='b',local_sku='one')
    _,conflicts,duplicates=keyed([a,a,dict(a,local_sku='two')],['msku','asin'])
    assert duplicates == 1
    assert len(conflicts[('a','b')]) == 2


def test_sales_nested_contract_and_ambiguous_binding():
    r=dict(mskuList=['a'],asinList=['b'],productIdList=['1'],fieldsMap={'sevenSaleNum':{'currValue':'4'}})
    rows,rejected=sales_rows([r,dict(r,asinList=['b','c'])])
    assert rows[0]['7天销量'] == 4
    assert rows[0]['14天销量'] is None
    assert len(rejected) == 1


def test_errors_preserve_diagnostics_and_redact():
    value={'detail':{'upstream':{'code':40014,'msg':'date required','token':'abc'}},'text':'Bearer abc'}
    result=redact(value,['abc'])
    assert result['detail']['upstream']['msg'] == 'date required'
    assert 'abc' not in str(result)


def test_replay_uses_fixed_inputs_and_changes_only_sales():
    from analyze_saihu_msku_compare import replay
    from decimal import Decimal
    source={'MSKU':'one','ASIN':'ASIN','父ASIN':'parent','本地SKU':'stock','商品链接':'https://www.amazon.com/dp/ASIN','7天销量':14,'14天销量':28,'30天销量':60,'可售':5,'待入库':0,'预留':0,'在途':0,'待调仓':0,'调仓中':0,'单品重量(g)(cm)':100}
    binding={'local_sku':'stock'}
    metrics={'7天销量':28,'14天销量':56,'30天销量':120}
    inputs=[(source,binding,metrics)]
    a,actual_a,_=replay(inputs,{}, {'stock':Decimal(200)},'mabang',{'one':3})
    b,actual_b,_=replay(inputs,{}, {'stock':Decimal(200)},'saihu',{'one':3})
    assert a[0]['actual_inventory']==b[0]['actual_inventory']==200
    assert a[0]['fba_total_inventory']==b[0]['fba_total_inventory']==5
    assert a[0]['unlinked_quantity']==b[0]['unlinked_quantity']==3
    assert a[0]['weighted_daily_sales']*2==b[0]['weighted_daily_sales']
    assert replay(inputs,{}, {'stock':Decimal(200)},'saihu',{'one':3})[0]==b
    second = dict(source, ASIN='SECOND', **{'7天销量':28,'14天销量':56,'30天销量':120})
    combined, _, _ = replay([*inputs, (second, binding, metrics)], {}, {'stock':Decimal(200)}, 'mabang', {'one':3})
    assert [row['asin'] for row in combined] == ['ASIN', 'SECOND']
    assert combined[0]['weighted_daily_sales'] * 2 == combined[1]['weighted_daily_sales']
