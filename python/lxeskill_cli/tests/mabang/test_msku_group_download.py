from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from mabang_test_helpers import _xlsx_bytes
from services.agent_cli.mabang import download_store_msku_excel as cli
from services.mabang.amazon.fba import store_msku as msku
from services.mabang.amazon.fba.combo_sku import ActiveListingSnapshot, ListingSkuBinding
from services.mabang.amazon.fba.store_resolver import FbaStore, parse_fba_store_options


def grouped_stores():
    return parse_fba_store_options('''<li><input name="fbaWarehouseIds[]" value="401403">
      <span class="texts">Shop-Group<span class="shop-country-cn">欧洲</span></span>
      <ul class="dropdown-menu">
        <li><a data-type="shopId" data-val="201">Shop-DE<span class="shop-country-cn">德国</span></a></li>
        <li><a data-type="shopId" data-val="202">Shop-FR<span class="shop-country-cn">法国</span></a></li>
      </ul></li>''')


@pytest.mark.parametrize('name', ['Shop-Group', 'Shop-Group欧洲'])
def test_group_cli_returns_real_children_without_export_or_auth_recovery(monkeypatch, tmp_path, name):
    stores = grouped_stores()
    # Matching the parent ID alone must not mix in children of another ID type.
    stores.append(FbaStore('unrelated', '203', 'shopId', parent_store_id='401403', parent_id_type='shopId'))
    async def fetch():
        return stores
    async def unexpected(*args, **kwargs):
        pytest.fail('Group must stop before MSKU lookup, export, download, or official lookup')
    def directory(*args, **kwargs):
        pytest.fail('Group must stop before output directory creation')
    monkeypatch.setattr(msku, 'fetch_fba_stores', fetch)
    for target in ['run_export_pipeline', 'fetch_store_msku_ids', 'export_store_msku_file_url', 'download_store_msku_excel_from_url', 'fetch_listing_snapshot']:
        monkeypatch.setattr(msku, target, unexpected)
    monkeypatch.setattr(msku, '_resolve_output_dir', directory)
    payload = cli.run({'store_name': name, 'store_id': '401403', 'id_type': 'fbaWarehouseIds[]'})
    assert payload['success'] is False
    assert payload['auth_refresh_required'] is False
    assert '当前选择的是多站点整组，请选择具体子站点' in payload['exception']
    assert '401403' in payload['exception']
    assert payload['context'] == {
        'reason': 'multi_site_group',
        'group': {'store_name': 'Shop-Group', 'store_id': '401403', 'id_type': 'fbaWarehouseIds[]'},
        'candidates': [
            {'store_name': 'Shop-DE', 'store_id': '201', 'id_type': 'shopId'},
            {'store_name': 'Shop-FR', 'store_id': '202', 'id_type': 'shopId'},
        ],
    }


@pytest.mark.parametrize('bad', ['wrong-name', 'wrong-id', 'ambiguous'])
def test_identity_errors_are_not_misreported_as_groups(monkeypatch, tmp_path, bad):
    stores = grouped_stores()
    if bad == 'ambiguous':
        stores.append(stores[0])
    async def fetch():
        return stores
    monkeypatch.setattr(msku, 'fetch_fba_stores', fetch)
    with pytest.raises(msku.StoreMskuDownloadError, match='未唯一对应') as exc:
        asyncio.run(msku.download_store_msku_excel('other' if bad == 'wrong-id' else '401403', 'fbaWarehouseIds[]', store_name='other' if bad == 'wrong-name' else 'Shop-Group', output_dir=tmp_path/'new'))
    assert not isinstance(exc.value, msku.StoreMskuGroupNotSupportedError)
    assert not (tmp_path/'new').exists()


@pytest.mark.parametrize('single', [FbaStore('Shop-Europe', '10'), grouped_stores()[1]])
def test_single_station_download_preserves_both_web_id_types(monkeypatch, tmp_path, single):
    stores = grouped_stores() + [FbaStore('Shop-Europe', '10')]
    calls = []
    async def fetch():
        return stores
    async def pipeline(spec):
        assert spec.fetch_args == (single.store_id, single.id_type)
        calls.append('export')
        path = spec.download_file.keywords['output_dir']/'202609071200-source.xlsx'
        path.write_bytes(_xlsx_bytes([{'店铺名称': single.store_name, 'MSKU': 'M', 'ASIN': 'A', '本地SKU': 'S'}], columns=list(msku.CORE_STORE_MSKU_HEADERS)))
        return spec.transform_result(['1'], path)
    async def snapshot(name):
        assert name == single.store_name
        calls.append('listing')
        return ActiveListingSnapshot(name, '99', 'de', (ListingSkuBinding('M', 'A', 'S', 1),))
    monkeypatch.setattr(msku, 'fetch_fba_stores', fetch)
    monkeypatch.setattr(msku, 'run_export_pipeline', pipeline)
    monkeypatch.setattr(msku, 'fetch_listing_snapshot', snapshot)
    result = asyncio.run(msku.download_store_msku_excel(single.store_id, single.id_type, store_name=single.store_name, output_dir=tmp_path))
    assert Path(result.xlsx_path).exists()
    assert result.active_counts == {'original_row_count': 1, 'active_row_count': 1, 'excluded_row_count': 0}
    assert calls == ['export', 'listing']


def test_group_context_survives_cli_terminal_without_cookie_recovery(monkeypatch, capsys):
    import json
    from lxeskill import cli as entrypoint
    async def fetch():
        return grouped_stores()
    monkeypatch.setattr(msku, 'fetch_fba_stores', fetch)
    def execute(entry, arguments, session, **kwargs):
        payload = cli.run(arguments)
        assert payload['success'] is False
        return False, [{'type': 'text', 'text': json.dumps(payload)}], [], {'code': 'business_cli_failed', 'message': payload['exception']}
    monkeypatch.setattr(entrypoint, 'execute_module_json', execute)
    assert entrypoint.main(['replenish', 'msku', 'download', '--store-name', 'Shop-Group', '--store-id', '401403', '--id-type', 'fbaWarehouseIds[]']) == entrypoint.EXIT_BUSINESS
    records = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert len(records) == 1
    terminal = records[0]
    assert terminal['ok'] is False and terminal['files'] == []
    assert terminal['data']['context']['reason'] == 'multi_site_group'
    assert len(terminal['data']['context']['candidates']) == 2
    assert '401403' in terminal['error']['message']
    assert 'recovery' not in terminal
