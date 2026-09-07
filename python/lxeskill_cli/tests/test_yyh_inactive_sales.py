import asyncio
import csv
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[3]/'scripts'))
from check_yyh_inactive_sales import compare, fetch_inactive, sales_number, write_csv, SID
from services.mabang.official_api import OfficialApiError


def listing(msku='M', **kw):
    return {'platformSku': msku, 'asin': 'A', 'stockSku': 'S', 'stockType': 1, 'shopIds': ','+SID, 'amazonsite': 'us', 'pStatus': '停售', **kw}


def source(msku='M', sales=0, **kw):
    return {'msku': msku, 'asin': 'A', 'local_sku': 'S', 'sales_7d': sales, 'excel_row': 2, **kw}


def page(rows, number=1, total=None, size=2):
    total = len(rows) if total is None else total
    return {'code': 200, 'data': {'list': rows, 'total': total, 'nowPage': number, 'totalPage': (total+size-1)//size}}


def test_complete_filtered_pagination():
    calls = []
    async def post(endpoint, body):
        calls.append(body)
        assert body['pStatus'] == ['Inactive'] and body['shop_id'] == [SID] and body['amazonsite'] == ['us']
        return page([listing('A'), listing('B')], total=3) if body['page'] == '1' else page([listing('C')], number=2, total=3)
    rows, pages = asyncio.run(fetch_inactive(post, page_size=2))
    assert len(rows) == 3 and pages == 2 and len(calls) == 2


@pytest.mark.parametrize('changes', [{'shopIds': 'other'}, {'shopIds': SID+',other'}, {'amazonsite': 'gb'}, {'pStatus': '在售'}, {'pStatus': None}])
def test_scope_and_status_failures(changes):
    async def post(*args):
        return page([listing(**changes)])
    with pytest.raises(OfficialApiError):
        asyncio.run(fetch_inactive(post, page_size=2))


@pytest.mark.parametrize('case', ['repeat', 'changed', 'short', 'wrong_page', 'business'])
def test_pagination_errors(case):
    async def post(endpoint, body):
        number = int(body['page'])
        if case == 'business':
            return {'code': 500}
        if case == 'short':
            return page([listing()], total=4)
        if case == 'wrong_page':
            return page([listing()], number=2)
        return page([listing('A'), listing('B')], number=number, total=5 if number == 2 and case == 'changed' else 4)
    with pytest.raises(OfficialApiError):
        asyncio.run(fetch_inactive(post, page_size=2))


@pytest.mark.parametrize('value', [None, '', 'NaN', 'Infinity', -1, True, 'bad', '1,2', '0.5'])
def test_invalid_sales_stay_unknown(value):
    summary, details = compare([listing()], [source(sales=value)])
    assert summary['unknown_count'] == 1 and summary['zero_count'] == 0
    assert details[0]['近7天销量'] is None
    assert summary['verdict'] == '没有可确认的销量，无法判断'


def test_zero_positive_missing_and_duplicate_conflicts(tmp_path):
    listings = [listing('zero'), listing('positive'), listing('missing'), listing('conflict'), listing('alias', stockSku='other'), listing('alias')]
    sources = [source('zero'), source('zero'), source('positive', sales='1,002'), source('conflict'), source('conflict', sales=2), source('alias')]
    summary, details = compare(listings, sources)
    assert (summary['inactive_unique_count'], summary['zero_count'], summary['positive_count'], summary['unknown_count']) == (5, 1, 1, 3)
    assert summary['verdict'] == '不是全部为零'
    assert summary['positive_examples'][0]['近7天销量'] == 1002
    assert summary['positive_sales_total'] == 1002
    assert details[0]['MSKU'] == 'positive'
    path = tmp_path/'details.csv'
    write_csv(path, details)
    with path.open(encoding='utf-8-sig', newline='') as f:
        saved = list(csv.DictReader(f))
    assert len(saved) == 5
    assert next(r for r in saved if r['MSKU'] == 'missing')['近7天销量'] == ''
    assert next(r for r in saved if r['MSKU'] == 'zero')['近7天销量'] == '0'


def test_no_local_sku_is_still_checked_and_no_cross_asin_match():
    summary, details = compare([listing('no-local', stockSku=''), listing('asin-change')], [source('no-local', sales=3, local_sku=''), source('asin-change', asin='B')])
    assert summary['positive_count'] == 1 and summary['unknown_count'] == 1


def test_all_zero_and_empty_are_distinct():
    assert compare([listing()], [source()])[0]['verdict'] == '本轮停售 MSKU 近7天销量全部为零'
    assert compare([listing(), listing('missing')], [source()])[0]['verdict'] == '已确认部分均为零，但无法确认全部'
    assert compare([], [source()])[0]['verdict'] == '本轮没有停售记录'
    async def post(*args):
        return page([])
    assert asyncio.run(fetch_inactive(post)) == ([], 1)
    assert sales_number('0.0') == 0


def test_case_preserved_and_duplicate_sales_not_summed():
    summary, details = compare([listing('M'), listing('M'), listing('m')], [source(sales=3), source(sales=3)])
    assert summary['positive_count'] == 1 and summary['unknown_count'] == 1
    assert summary['listing_duplicate_count'] == 1 and details[0]['近7天销量'] == 3
