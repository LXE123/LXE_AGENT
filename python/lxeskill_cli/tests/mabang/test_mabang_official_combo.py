from __future__ import annotations
import asyncio
import copy
import json
from datetime import datetime
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace
import aiohttp
import pytest
from services.mabang import official_api as http
from services.mabang.amazon.fba import combo_sku as combo
from services.mabang.amazon.fba import store_msku_actual_inventory as inv
FIXTURE = json.loads((Path(__file__).parent / 'fixtures/official_combo_contract.json').read_text())

def source(msku='M', sku='C', asin='A'):
    return SimpleNamespace(msku=msku, local_sku=sku, asin=asin)

def binding(msku='M', sku='C', asin='A', kind=2):
    return combo.ListingSkuBinding(msku, asin, sku, kind)

def combo_page(sku='C', page=1, total=1, records=None):
    return {'code': 200, 'data': {'page': str(page), 'rowsPerPage': '20', 'total': total, 'data': records if records is not None else [{'comboSku': sku, 'comboProductDetail': [{'stockSku': 'S', 'quantity': 2}]}]}}

def listing(msku='M', sku='C', site='us', shop='10', kind=2):
    return {'platformSku': msku, 'asin': 'A', 'stockSku': sku, 'stockType': kind, 'pStatus': '在售', 'shopIds': f',{shop},', 'amazonsite': site}

def listing_page(records, page=1, total=None):
    total = len(records) if total is None else total
    return {'code': 200, 'data': {'list': records, 'total': total, 'nowPage': str(page), 'totalPage': max(1, (total + 999) // 1000)}}

def test_real_combo_fixture_and_empty_result(monkeypatch):

    async def post(endpoint, body, **kw):
        return copy.deepcopy(FIXTURE['combo' if body['comboSku'] == 'HSP022' else 'empty'])
    monkeypatch.setattr(combo, 'post_json', post)
    result = asyncio.run(combo.fetch_combo_sku_map(['HSP022', ' HSP022 ', '']))
    assert len(result) == 1
    assert len(result['HSP022'].components) == 8
    assert all((x.quantity == Decimal(1) for x in result['HSP022'].components))
    with pytest.raises(http.OfficialApiError, match='未找到精确匹配'):
        asyncio.run(combo.fetch_combo_sku_map(['missing']))

def test_binding_matching_and_only_combos(monkeypatch):
    rows = [source('N', 'N'), source(), source('M2'), source('empty', '')]
    bindings = [binding('N', 'N', kind=1), binding(), binding(), binding('M2')]
    assert combo.select_combo_skus(rows, bindings) == ['C']
    calls = []

    async def listing_fetch(name):
        return bindings

    async def post(endpoint, body, **kw):
        calls.append(body['comboSku'])
        return combo_page(body['comboSku'])
    monkeypatch.setattr(combo, 'fetch_listing_bindings', listing_fetch)
    monkeypatch.setattr(combo, 'post_json', post)
    result = asyncio.run(combo.fetch_inventory_combos('shop', rows))
    assert list(result) == ['C'] and calls == ['C']
    assert combo.select_combo_skus([source(asin='')], [binding(), binding(asin='B')]) == ['C']
    assert asyncio.run(combo.fetch_inventory_combos('shop', [source(sku='')])) == {}

@pytest.mark.parametrize('rows,bindings', [([source()], []), ([source()], [binding(sku='changed')]), ([source()], [binding(), binding(kind=1)]), ([source(asin='')], [binding(), binding(asin='B', sku='other')]), ([source(), source('M2')], [binding(), binding('M2', kind=1)]), ([source()], [binding(asin='other')])])
def test_binding_failures(rows, bindings):
    with pytest.raises(http.OfficialApiError):
        combo.select_combo_skus(rows, bindings)


@pytest.mark.parametrize('msku', ['Amazon.Found.A', 'ordinary', 'XAmazon.Found.A', 'amazon.found.A'])
def test_combo_selector_requires_preverified_rows(msku):
    with pytest.raises(http.OfficialApiError):
        combo.select_combo_skus([source(msku)], [])


@pytest.mark.parametrize('bindings', [
    [binding('Amazon.Found.A', 'changed')],
    [binding('Amazon.Found.A', 'S', asin='different')],
    [binding('Amazon.Found.A', 'S'), binding('Amazon.Found.A', 'S', kind=1)],
    [binding('Amazon.Found.A', 'S', kind=3)],
])
def test_found_conflicts_are_not_suppressed(bindings):
    with pytest.raises(http.OfficialApiError):
        combo.select_combo_skus([source('Amazon.Found.A', 'S')], bindings)


def test_found_with_valid_combo_binding_is_still_a_combo():
    skipped = set()
    assert combo.select_combo_skus([source('Amazon.Found.A', 'C')], [binding('Amazon.Found.A')]) == ['C']
    assert skipped == set()


def test_found_unknown_quantity_does_not_affect_verified_shared_sku():
    found = inv.StoreMskuRow('Amazon.Found.A', '', 'A', 'S', '', remark='原备注')
    normal = inv.StoreMskuRow('normal', '', 'A', 'S', '')
    rows, missing = inv.calculate_inventory_rows([found, normal], combo_map={}, stock_quantities={'S': Decimal(100)}, unverified_rows={inv.product_key(found): "SKU类型未核验"})
    assert rows[0].actual_inventory is None
    assert rows[1].actual_inventory == 100
    assert '原备注' in rows[0].remark and 'SKU类型未核验' in rows[0].remark
    assert missing == []
    assert inv.split_inventory_rows(rows).no_inventory_rows == [rows[0]]


def test_only_found_rows_do_not_query_warehouse_or_enter_replenishment(monkeypatch, tmp_path):
    from services.mabang.amazon.fba.source_verification import annotate_source, SourceVerificationError
    from mabang_test_helpers import _xlsx_bytes
    path = tmp_path/'202609071111-shop_店铺MSKU数据.xlsx'
    path.write_bytes(_xlsx_bytes([{'MSKU': 'Amazon.Found.A', 'ASIN': 'A', '本地SKU': 'S'}], columns=list(inv.SOURCE_COLUMNS)))
    from services.mabang.amazon.fba.sku_catalog import SkuCatalogSnapshot, LocalSkuDefinition
    annotate_source(path, SkuCatalogSnapshot('shop', '10', 'shopId', (LocalSkuDefinition('S', None),)), requested_store_name='shop')
    async def unexpected(*args, **kwargs):
        pytest.fail('Unverified rows must not query stock or combo details')
    monkeypatch.setattr(combo, 'post_json', unexpected)
    monkeypatch.setattr(inv, 'search_warehouse_stock', unexpected)
    result = asyncio.run(inv.export_store_msku_actual_inventory('shop', input_dir=tmp_path, output_dir=tmp_path/'out'))
    assert result.missing_warehouse_inventory_msku_row_count == 1
    from services.mabang.amazon.fba.store_msku_replenishment import load_inventory_rows
    assert load_inventory_rows(result.shenzhen_warehouse_inventory_report_xlsx_path) == []


def test_shop_sid_uk_conversion_and_listing_pagination(monkeypatch):
    calls = []

    async def post(endpoint, body, **kw):
        calls.append((endpoint, body))
        if endpoint == 'shops/list':
            return {'code': 200, 'data': {'profile-key': {'name': 'shop', 'sid': 10, 'profile_id': 'wrong', 'amazonsite': 'uk'}}}
        assert body['shop_id'] == ['10'] and body['amazonsite'] == ['gb']
        assert set(body) == {'shop_id', 'amazonsite', 'page', 'pageSize'}
        assert 'pStatus' not in body
        page = int(body['page'])
        records = [listing(msku=str(i), site='uk') for i in range(1000)] if page == 1 else [listing('last', site='gb')]
        return listing_page(records, page, 1001)
    monkeypatch.setattr(combo, 'post_json', post)
    result = asyncio.run(combo.fetch_listing_bindings('shop'))
    assert len(result) == 1001 and len(calls) == 3

@pytest.mark.parametrize('bad', [listing(shop='11'), listing(site='de'), listing(kind=3), listing(kind=True), {'platformSku': 'M', 'stockSku': 'C', 'shopIds': '10', 'amazonsite': 'us'}])
def test_listing_rejects_wrong_scope_and_type(monkeypatch, bad):

    async def post(endpoint, body, **kw):
        if endpoint == 'shops/list':
            return {'code': 200, 'data': {'profile': {'name': 'shop', 'sid': 10, 'amazonsite': 'us'}}}
        return listing_page([bad])
    monkeypatch.setattr(combo, 'post_json', post)
    with pytest.raises(http.OfficialApiError):
        asyncio.run(combo.fetch_listing_bindings('shop'))

@pytest.mark.parametrize('shops', [{}, {'x': {'name': 'other', 'sid': 10, 'amazonsite': 'us'}}, {'x': {'name': 'shop', 'sid': 10, 'amazonsite': 'us'}, 'y': {'name': 'shop', 'sid': 11, 'amazonsite': 'us'}}, {'x': {'name': 'shop', 'profile_id': '10', 'amazonsite': 'us'}}, {'x': {'name': 'shop', 'sid': 10}}])
def test_shop_resolution_failure(monkeypatch, shops):

    async def web_stores():
        return []
    monkeypatch.setattr(combo, 'fetch_fba_stores', web_stores)

    async def post(*a, **kw):
        return {'code': 200, 'data': shops}
    monkeypatch.setattr(combo, 'post_json', post)
    with pytest.raises(http.OfficialApiError):
        asyncio.run(combo.fetch_listing_bindings('shop'))


@pytest.mark.parametrize('requested', ['Amazon-YYH-US', 'Amazon-YYH-US美国'])
def test_official_shop_uses_verified_web_alias_only(monkeypatch, requested):
    from services.mabang.amazon.fba import store_resolver as stores
    calls = []
    async def web_stores():
        calls.append('web')
        return stores.parse_fba_store_options('<li><input name="fbaWarehouseIds[]" value="1039477"><span class="texts">Amazon-YYH-US<span class="shop-country-cn">美国</span></span></li>')
    async def post(endpoint, body, **kw):
        if endpoint == 'shops/list':
            return {'code': 200, 'data': {'profile-403': {'name': 'Amazon-YYH-US', 'sid': 10, 'amazonsite': 'us'}}}
        assert body['shop_id'] == ['10']
        calls.append('listing')
        return listing_page([])
    monkeypatch.setattr(combo, 'fetch_fba_stores', web_stores)
    monkeypatch.setattr(combo, 'post_json', post)
    assert asyncio.run(combo.fetch_listing_bindings(requested)) == []
    assert calls == (['web', 'listing'] if requested.endswith('美国') else ['listing'])
    with pytest.raises(http.OfficialApiError, match='店铺精确匹配数量=0'):
        asyncio.run(combo.fetch_listing_bindings('Amazon-YYH-US英国'))


def test_ambiguous_web_alias_stops_before_listing(monkeypatch):
    from services.mabang.amazon.fba import store_resolver as stores
    async def web_stores():
        return [stores.FbaStore('shop', str(i), legacy_names=('shop美国',)) for i in [1, 2]]
    async def post(endpoint, body, **kw):
        assert endpoint == 'shops/list'
        return {'code': 200, 'data': {'p': {'name': 'shop', 'sid': 10, 'amazonsite': 'us'}}}
    monkeypatch.setattr(combo, 'fetch_fba_stores', web_stores)
    monkeypatch.setattr(combo, 'post_json', post)
    with pytest.raises(stores.FbaStoreAmbiguousError):
        asyncio.run(combo.fetch_listing_bindings('shop美国'))


def test_official_exact_name_wins_over_web_alias(monkeypatch):
    async def web_stores():
        pytest.fail('Exact official name must not fetch cookies or web aliases')
    async def post(endpoint, body, **kw):
        if endpoint == 'shops/list':
            return {'code': 200, 'data': {'p': {'name': 'shop美国', 'sid': 10, 'amazonsite': 'us'}}}
        return listing_page([])
    monkeypatch.setattr(combo, 'fetch_fba_stores', web_stores)
    monkeypatch.setattr(combo, 'post_json', post)
    assert asyncio.run(combo.fetch_listing_bindings('shop美国')) == []

def test_combo_paginates_and_exact_matches(monkeypatch):
    calls = []

    async def post(endpoint, body, **kw):
        page = body['page']
        calls.append(page)
        assert body['showCost'] == 0 and body['rowsPerPage'] == 20
        records = [{'comboSku': f'C-{i}'} for i in range(20)] if page == 1 else combo_page()['data']['data']
        return combo_page(page=page, total=21, records=records)
    monkeypatch.setattr(combo, 'post_json', post)
    assert list(asyncio.run(combo.fetch_combo_sku_map(['C']))) == ['C']
    assert calls == [1, 2]

@pytest.mark.parametrize('details', [[], None, [{'stockSku': 'S', 'quantity': 0}], [{'stockSku': 'S', 'quantity': -1}], [{'stockSku': 'S', 'quantity': 'NaN'}], [{'stockSku': 'S', 'quantity': 'Infinity'}], [{'stockSku': 'S', 'quantity': 'invalid'}], [{'stockSku': '', 'quantity': 1}], [{'stockSku': 'S', 'quantity': 1}, {'stockSku': ' S ', 'quantity': 2}]])
def test_invalid_components(monkeypatch, details):

    async def post(*a, **kw):
        p = combo_page()
        p['data']['data'][0]['comboProductDetail'] = details
        return p
    monkeypatch.setattr(combo, 'post_json', post)
    with pytest.raises(http.OfficialApiError):
        asyncio.run(combo.fetch_combo_sku_map(['C']))

@pytest.mark.parametrize('case', ['missing', 'count', 'repeat', 'changed', 'conflict'])
def test_combo_invalid_pages(monkeypatch, case):

    async def post(endpoint, body, **kw):
        page = body['page']
        if case == 'missing':
            return {'code': 200, 'data': []}
        if case == 'count':
            return combo_page(total=3)
        if case == 'conflict':
            records = combo_page()['data']['data']
            other = copy.deepcopy(records[0])
            other['comboProductDetail'][0]['quantity'] = 3
            return combo_page(total=2, records=records + [other])
        records = [{'comboSku': f'other-{i}'} for i in range(20)]
        return combo_page(page=page, total=40 if page == 1 or case == 'repeat' else 41, records=records)
    monkeypatch.setattr(combo, 'post_json', post)
    with pytest.raises(http.OfficialApiError):
        asyncio.run(combo.fetch_combo_sku_map(['C']))

def test_bounded_workers_cancel_and_deadline(monkeypatch):

    async def scenario(fail=False):
        active = peak = cancelled = started = 0
        ready = asyncio.Event()

        async def fetch(sku):
            nonlocal active, peak, cancelled, started
            active += 1
            started += 1
            peak = max(peak, active)
            if active == 4:
                ready.set()
            try:
                await ready.wait()
                if fail and sku == '0':
                    raise http.OfficialApiError('SKU=0', 'real failure')
                await asyncio.sleep(0.01 if not fail else 60)
                return combo.ComboSku(sku, (combo.ComboComponent('S', Decimal(1)),))
            except asyncio.CancelledError:
                cancelled += 1
                raise
            finally:
                active -= 1
        monkeypatch.setattr(combo, '_fetch_combo', fetch)
        if fail:
            with pytest.raises(http.OfficialApiError, match='real failure'):
                await combo.fetch_combo_sku_map([str(i) for i in range(20)])
            assert cancelled == 3 and started == 4
        else:
            assert len(await combo.fetch_combo_sku_map([str(i) for i in range(20)])) == 20
        assert peak == 4 and active == 0
    asyncio.run(scenario())
    asyncio.run(scenario(True))

    async def forever(name):
        await asyncio.sleep(60)
    monkeypatch.setattr(combo, 'fetch_listing_bindings', forever)
    monkeypatch.setattr(combo, 'OFFICIAL_LOOKUP_TIMEOUT_SECONDS', 0.001)
    with pytest.raises(http.OfficialApiError, match='超过'):
        asyncio.run(combo.fetch_inventory_combos('shop', [source()]))

class Response:

    def __init__(self, status=200, payload=None, raw=None, headers=None):
        self.status = status
        self.payload = payload
        self.raw = raw
        self.headers = headers or {}

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        pass

    async def text(self):
        return self.raw if self.raw is not None else json.dumps(self.payload)

class Session:

    def __init__(self, responses):
        self.responses = iter(responses)
        self.calls = []

    def post(self, url, **kwargs):
        self.calls.append((url, kwargs))
        result = next(self.responses)
        if isinstance(result, Exception):
            raise result
        return result

@pytest.fixture
def transport(monkeypatch):
    monkeypatch.setenv('LXE_DATA_SERVER_URL', 'http://data.test/')
    monkeypatch.setenv('LXE_DATA_SERVER_API_KEY', 'data-secret')
    monkeypatch.setenv('LXE_ERP_API_KEY', 'erp-secret')
    sleeps = []

    async def sleep(delay):
        sleeps.append(delay)
    monkeypatch.setattr(http.asyncio, 'sleep', sleep)

    def setup(responses):
        session = Session(responses)
        monkeypatch.setattr(http, 'data_service_http_session', session)
        return (session, sleeps)
    return setup

def test_transport_auth_and_retries(transport):
    session, sleeps = transport([Response(429, {'detail': 'limited'}, headers={'Retry-After': '3'}), Response(503, raw='gateway unavailable'), Response(payload={'code': 200, 'data': {}})])
    assert asyncio.run(http.post_json('shops/list', {}, context='shop'))['code'] == 200
    assert sleeps == [3, 2] and len(session.calls) == 3
    url, kw = session.calls[0]
    assert url == 'http://data.test/api/v1/data-sources/mabang/shops/list'
    assert kw['headers']['Authorization'] == 'Bearer data-secret'
    assert kw['timeout'].total == 60 and kw['allow_redirects'] is False
    assert 'Cookie' not in kw['headers']

@pytest.mark.parametrize('status,payload', [(401, {'detail': 'denied'}), (403, {}), (422, {}), (502, {'detail': {'upstream': {'code': 500, 'message': 'real business failure'}}}), (200, {'code': 500, 'message': 'failed'}), (200, [])])
def test_transport_no_retry_and_actual_error(transport, status, payload):
    session, sleeps = transport([Response(status, payload)])
    with pytest.raises(http.OfficialApiError, match=f'HTTP {status}') as exc:
        asyncio.run(http.post_json('combo-skus/search', {}, context='SKU=C page=2'))
    assert 'SKU=C page=2' in str(exc.value) and len(session.calls) == 1 and (sleeps == [])
    if status == 502:
        assert 'real business failure' in str(exc.value)

def test_transport_exceptions_and_redaction(transport):
    session, sleeps = transport([aiohttp.ClientConnectionError('reset data-secret')] * 3)
    with pytest.raises(http.OfficialApiError, match='ClientConnectionError: reset') as exc:
        asyncio.run(http.post_json('shops/list', {}, context='shop'))
    assert 'data-secret' not in str(exc.value) and sleeps == [1, 2]
    session, _ = transport([Response(500, {'detail': {'upstream': {'message': 'actual failure', 'token': 'unknown-secret', 'body': 'data-secret erp-secret ' + 'X' * 8000}}})])
    with pytest.raises(http.OfficialApiError) as exc:
        asyncio.run(http.post_json('shops/list', {}, context='shop'))
    text = str(exc.value)
    assert 'actual failure' in text and '[truncated' in text
    assert all((secret not in text for secret in ('data-secret', 'erp-secret', 'unknown-secret')))

def test_snapshot_failure_blocks_warehouse_and_cookie_retry_is_local(monkeypatch, tmp_path):
    from mabang_test_helpers import _xlsx_bytes
    from services.mabang.amazon.fba.source_verification import annotate_source, SourceVerificationError
    from services.mabang.amazon.fba.sku_catalog import LocalSkuDefinition, SkuCatalogSnapshot
    path = tmp_path/'202609050900-shop_店铺MSKU数据.xlsx'
    path.write_bytes(_xlsx_bytes([{'MSKU': 'M', 'ASIN': 'A', '本地SKU': 'C'}], columns=list(inv.SOURCE_COLUMNS)))
    annotate_source(path, SkuCatalogSnapshot('shop', '10', 'shopId', (LocalSkuDefinition('C', 2, (combo.ComboComponent('S', Decimal(2)),)),)), requested_store_name='shop')
    calls = []
    async def forbidden(*a, **kw):
        pytest.fail('Inventory must not query Listing or product catalogs again')
    async def search(skus):
        assert skus == ['S']
        calls.append('warehouse')
        if len(calls) == 1:
            raise inv.StoreMskuActualInventoryAuthError('expired cookie')
    async def refresh(**kw):
        calls.append('refresh')
    async def download(**kw):
        return Path('stock.xlsx')
    monkeypatch.setattr(combo, 'post_json', forbidden)
    monkeypatch.setattr(inv, 'search_warehouse_stock', search)
    monkeypatch.setattr(inv, 'refresh_mabang_auth', refresh)
    monkeypatch.setattr(inv, 'download_warehouse_stock_xlsx', download)
    monkeypatch.setattr(inv, 'parse_stock_inventory_xlsx', lambda *a: {'S': Decimal(10)})
    result = asyncio.run(inv.export_store_msku_actual_inventory('shop', input_dir=tmp_path, output_dir=tmp_path/'out'))
    assert calls == ['warehouse', 'refresh', 'warehouse']
    report = Path(result.shenzhen_warehouse_inventory_report_xlsx_path)
    original = report.read_bytes()
    calls.clear()
    def failure(*a, **kw):
        raise SourceVerificationError('snapshot changed')
    monkeypatch.setattr(inv, 'load_verified_source', failure)
    with pytest.raises(SourceVerificationError):
        asyncio.run(inv.export_store_msku_actual_inventory('shop', input_dir=tmp_path, output_dir=tmp_path/'out'))
    assert calls == [] and report.read_bytes() == original


def test_listing_projection_with_active_status_keeps_unpaired_binding(monkeypatch):
    async def post(endpoint, body, **kwargs):
        if endpoint == 'shops/list':
            return {'code': 200, 'data': {'wrong-profile-key': FIXTURE['shop']}}
        assert body['shop_id'] == [str(FIXTURE['shop']['sid'])]
        return listing_page([{**row, 'pStatus': '在售'} for row in copy.deepcopy(FIXTURE['listing_projection'])])

    monkeypatch.setattr(combo, 'post_json', post)
    bindings = asyncio.run(combo.fetch_listing_bindings('Amazon-YYH-US'))
    assert len(bindings) == 3
    assert bindings[0].local_sku == ''
    assert [item.stock_type for item in bindings] == [1, 1, 2]
    with pytest.raises(http.OfficialApiError, match='绑定变化'):
        combo.select_combo_skus([source(bindings[0].msku, 'OLD', bindings[0].asin)], bindings)


@pytest.mark.parametrize('mode', ['count', 'changed', 'repeat', 'page'])
def test_listing_inconsistent_pagination(monkeypatch, mode):
    async def post(endpoint, body, **kwargs):
        if endpoint == 'shops/list':
            return {'code': 200, 'data': {'profile': {'name': 'shop', 'sid': 10, 'amazonsite': 'us'}}}
        page = int(body['page'])
        records = [listing(str(i)) for i in range(1000)]
        if mode == 'count':
            records.pop()
        result = listing_page(records, page, 2000)
        if mode == 'changed' and page == 2:
            result['data']['total'] = 2001
        if mode == 'page':
            result['data']['nowPage'] = '9'
        return result

    monkeypatch.setattr(combo, 'post_json', post)
    with pytest.raises(http.OfficialApiError):
        asyncio.run(combo.fetch_listing_bindings('shop'))


def test_empty_listing_page(monkeypatch):
    async def post(endpoint, body, **kwargs):
        if endpoint == 'shops/list':
            return {'code': 200, 'data': {'profile': {'name': 'shop', 'sid': 10, 'amazonsite': 'us'}}}
        return listing_page([])

    monkeypatch.setattr(combo, 'post_json', post)
    assert asyncio.run(combo.fetch_listing_bindings('shop')) == []


@pytest.mark.parametrize('value,expected', [('NaN', 2), ('Infinity', 2), ('-1', 2), ('invalid', 2), ('0', 0), ('4', 4)])
def test_retry_after_validation(value, expected):
    assert http.retry_delay(value, 2) == expected


def test_missing_credentials_do_not_call_network(monkeypatch, transport):
    session, _ = transport([])
    monkeypatch.delenv('LXE_DATA_SERVER_API_KEY')
    with pytest.raises(http.OfficialApiError, match='未配置'):
        asyncio.run(http.post_json('shops/list', {}, context='shop'))
    assert session.calls == []


def test_quoted_secret_with_spaces_is_fully_redacted():
    assert 'long secret' not in http.diagnostic('password="long secret"; actual error')
    assert 'actual error' in http.diagnostic('password="long secret"; actual error')
    assert 'upstream-key' not in http.diagnostic({'appkey': 'upstream-key', 'message': 'actual error'})
