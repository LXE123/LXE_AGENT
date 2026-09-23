from __future__ import annotations

import io
from pathlib import Path
from unittest.mock import Mock

import pytest
import requests
from openpyxl import Workbook, load_workbook

from services.mabang_tms import workflow
from services.mabang_tms.client import FIELDS, TmsClient, TmsError, diagnostic
from services.mabang_tms.workbooks import coverage, read_workbook, write_merged

HEADERS = ['库存SKU', '30天销量', '7天销量', '可用库存', '15天销量', '仓库',
           '库存量', '在途量', '成本价', '采购价', '入库时间', '平台额外销量']


def workbook(rows, headers=HEADERS):
    wb = Workbook()
    wb.active.append(headers)
    for row in rows:
        wb.active.append(row)
    stream = io.BytesIO()
    wb.save(stream)
    wb.close()
    return stream.getvalue()


def record(i, **kw):
    return {'id': i, 'stockSku': f'SKU-{i}', 'warehouseName': '测试仓', **kw}


def values(r):
    return [r['stockSku'], '97', '21', 0, '71', r['warehouseName'], -1, 0, 0, 0, '2026-08-25 11:35:29', '123']


class FakeClient:
    def __init__(self, pages):
        self.pages = pages
        self.login_count = 0
        self.calls = []
        self.contents = []
        self.token = 'test-token'

    def login(self):
        self.login_count += 1

    def check_budget(self):
        pass

    def list_page(self, page):
        self.calls.append(('list', page))
        self.current = self.pages[page - 1]
        return self.current

    def export(self, ids):
        self.calls.append(('export', ids))
        return 'https://tms-cos.mabangerp.com/test?signature=secret'

    def download(self, url):
        self.calls.append(('download', None))
        content = workbook([values(r) for r in self.current['datas']])
        self.contents.append(content)
        return content

    def safe(self, value):
        return diagnostic(value, ('test-token', 'password'))

    def close(self):
        self.token = ''


def execute(monkeypatch, tmp_path, pages, client=None):
    client = client or FakeClient(pages)
    monkeypatch.setenv('LXE_MABANG_TMS_ACCOUNT', 'account')
    monkeypatch.setenv('LXE_MABANG_TMS_PASSWORD', 'password')
    monkeypatch.setattr(workflow, 'TmsClient', lambda *args: client)
    monkeypatch.setattr(workflow, 'dataset_dir', lambda *args: tmp_path.joinpath(*args[1:]))
    return workflow.run({}), client


def page(records, total, number=1):
    return {'code': '200', 'datas': records, 'totalNum': total, 'page': number}


def test_short_pages_continue_until_total_and_original_bytes_preserved(monkeypatch, tmp_path):
    result, client = execute(monkeypatch, tmp_path, [page([record(1)], 2), page([record(2)], 2, 2)])
    assert result['success'] and result['read_unique_ids'] == result['reported_total'] == 2
    assert result['completed_batches'] == 2 and client.login_count == 1
    assert [c[0] for c in client.calls] == ['list', 'export', 'download'] * 2
    assert client.token == ''
    for batch, content in zip(result['batches'], client.contents):
        from pathlib import Path
        assert Path(batch['raw_path']).read_bytes() == content
    assert len(result['artifacts']) == 1
    wb = load_workbook(result['artifacts'][0]['path'])
    assert wb.active.max_row == 3
    assert wb.active['B2'].value == '97' and wb.active['G2'].value == -1
    wb.close()


def test_8386_records_nine_batches(monkeypatch, tmp_path):
    pages = [page([record(j) for j in range(i, min(i + 1000, 8386))], 8386, i // 1000 + 1)
             for i in range(0, 8386, 1000)]
    result, client = execute(monkeypatch, tmp_path, pages)
    assert result['success'] and result['row_count'] == 8386
    assert result['completed_batches'] == 9 and client.login_count == 1


@pytest.mark.parametrize('second,code', [
    (page([], 2, 2), 'early_empty_page'),
    (page([record(2)], 3, 2), 'total_changed'),
    (page([record(1)], 2, 2), 'duplicate_id'),
    (page([record(2)], 2, 1), 'page_mismatch'),
    (page([record(2), record(3)], 2, 2), 'total_exceeded'),
])
def test_partial_not_success_on_incomplete_pagination(monkeypatch, tmp_path, second, code):
    result, client = execute(monkeypatch, tmp_path, [page([record(1)], 2), second])
    assert not result['success'] and result['error']['code'] == code
    assert result['status'] == 'partial_success' and len(result['artifacts']) == 1
    assert result['exported_unique_ids'] == 1 and result['remaining_records'] == 1
    assert len([c for c in client.calls if c[0] == 'export']) == 1


def test_zero_no_fake_attachment(monkeypatch, tmp_path):
    result, _ = execute(monkeypatch, tmp_path, [page([], 0)])
    assert result['success'] and result['artifacts'] == [] and result['row_count'] == 0


def test_sample_shape_fifty_rows_fortyone_skus_preserved(monkeypatch, tmp_path):
    records = [record(i, stockSku=f'SAMPLE-{i if i < 41 else i-41}') for i in range(50)]
    result, _ = execute(monkeypatch, tmp_path, [page(records, 50)])
    assert result['success'] and result['row_count'] == 50 and result['distinct_skus'] == 41
    assert result['headers'] == HEADERS


def test_eleven_column_sample_and_unknown_extra_column():
    for headers in (HEADERS[:11], HEADERS):
        content = workbook([values(record(1))[:len(headers)]], headers)
        actual, rows, _ = read_workbook(content)
        assert actual == tuple(headers) and rows[0][1] == '97'


@pytest.mark.parametrize('records,rows', [
    ([record(1)], [values(record(2))]),
    ([record(1)], [values(record(1, warehouseName='另一个仓'))]),
    ([{'id': 1}], [values(record(1))]),
])
def test_coverage_fails_closed(records, rows):
    with pytest.raises(TmsError):
        coverage(records, HEADERS, rows)


def test_one_id_may_expand_to_multiple_rows():
    coverage([record(1)], HEADERS, [values(record(1)), values(record(1))])


def test_save_failure_reports_both_original_and_publication_error(monkeypatch, tmp_path):
    def fail(*args):
        raise OSError('disk full')
    monkeypatch.setattr(workflow, 'write_merged', fail)
    result, _ = execute(monkeypatch, tmp_path, [page([record(1)], 2), page([], 2, 2)])
    assert not result['success'] and result['artifacts'] == []
    assert result['error']['code'] == 'early_empty_page'
    assert 'disk full' in result['error']['publication_error']


def test_atomic_publication_and_literal_strings(tmp_path):
    row = values(record(1, stockSku='=not-a-formula'))
    write_merged(tmp_path / 'out.xlsx', HEADERS, [row])
    wb = load_workbook(tmp_path / 'out.xlsx')
    assert wb.active['A2'].data_type == 's'
    wb.close()


def response(status=200, body=None, text='response'):
    r = Mock(status_code=status, text=text)
    r.json.return_value = body if body is not None else {'code': '200'}
    return r


@pytest.mark.parametrize('status', [401, 403, 429, 302])
def test_rejections_never_retry(status):
    session = Mock()
    session.post.return_value = response(status, text='actual platform error')
    client = TmsClient('account', 'password', session=session, sleeper=lambda _: None)
    with pytest.raises(TmsError, match='actual platform error'):
        client.list_page(1)
    assert session.post.call_count == 1


def test_only_list_retries_and_keeps_fixed_fields():
    session = Mock()
    session.post.side_effect = [response(503), response(body={'code': '200', 'datas': [], 'totalNum': 0})]
    client = TmsClient('account', 'password', session=session, sleeper=lambda _: None)
    client.list_page(1)
    assert session.post.call_count == 2
    session.post.reset_mock()
    session.post.side_effect = requests.Timeout('actual timeout')
    with pytest.raises(TmsError, match='actual timeout'):
        client.export([1])
    assert session.post.call_count == 1
    assert session.post.call_args.kwargs['json']['stockValueArr'] == FIELDS
    assert len(FIELDS) == 12 and FIELDS[-1] == 'sale5'


@pytest.mark.parametrize('body', [{'code': '200'}, {'code': '200', 'data': {'apiToken': ''}}, {'code': '401', 'msg': 'denied'}])
def test_bad_login_never_retries(body):
    session = Mock()
    session.post.return_value = response(body=body)
    with pytest.raises(TmsError):
        TmsClient('account', 'password', session=session).login()
    assert session.post.call_count == 1


def test_non_json_and_redaction_before_truncation():
    session = Mock()
    session.post.return_value = response(text='pwd=password https://host/x?sig=private ' + 'x'*5000)
    session.post.return_value.json.side_effect = ValueError('not json')
    with pytest.raises(TmsError) as caught:
        TmsClient('account', 'password', session=session).login()
    message = str(caught.value)
    assert 'password' not in message and 'sig=private' not in message and '[truncated]' in message


def test_account_lock_and_credential_absence(monkeypatch, tmp_path):
    monkeypatch.delenv('LXE_MABANG_TMS_ACCOUNT', raising=False)
    monkeypatch.delenv('LXE_MABANG_TMS_PASSWORD', raising=False)
    assert workflow.run({})['error']['code'] == 'credentials_missing'
    assert workflow.run({'extra': True})['error']['code'] == 'invalid_arguments'


def test_unsafe_download_url_never_requested():
    client = TmsClient('a', 'p')
    with pytest.raises(TmsError):
        client.download('https://untrusted.test/file')


def test_corrupt_file_and_missing_headers():
    with pytest.raises(TmsError):
        read_workbook(b'not excel')
    with pytest.raises(TmsError):
        read_workbook(workbook([['value']], ['wrong']))


@pytest.mark.parametrize('stage', ['login', 'export', 'download'])
def test_task_stops_after_uncertain_failure(monkeypatch, tmp_path, stage):
    client = FakeClient([page([record(1)], 2), page([record(2)], 2, 2)])
    def fail(*args):
        raise TmsError('uncertain', 'actual timeout password test-token')
    setattr(client, stage, fail)
    result, _ = execute(monkeypatch, tmp_path, [], client)
    assert not result['success'] and not result['artifacts']
    assert 'password' not in str(result) and 'test-token' not in str(result)
    assert len([c for c in client.calls if c[0] == 'list']) <= 1


def test_header_change_preserves_only_validated_batch(monkeypatch, tmp_path):
    client = FakeClient([page([record(1)], 2), page([record(2)], 2, 2)])
    original_download = client.download
    def download(url):
        if client.current['page'] == 2:
            return workbook([values(record(2))[:11]], HEADERS[:11])
        return original_download(url)
    client.download = download
    result, _ = execute(monkeypatch, tmp_path, [], client)
    assert result['status'] == 'partial_success' and result['error']['code'] == 'header_mismatch'
    assert result['completed_batches'] == 1


def test_account_directories_isolated_and_busy_lock_prevents_login(monkeypatch, tmp_path):
    import hashlib
    from shared.process_lock import interprocess_lock
    account_root = tmp_path / hashlib.sha256(b'account').hexdigest()
    account_root.mkdir()
    with interprocess_lock(account_root / '.export.lock', timeout_seconds=0):
        result, client = execute(monkeypatch, tmp_path, [page([], 0)])
    assert not result['success'] and client.login_count == 0
    result, _ = execute(monkeypatch, tmp_path, [page([record(1)], 1)])
    assert Path(result['artifacts'][0]['path']).is_relative_to(account_root)


def test_download_no_retry_and_no_auth_forwarding(monkeypatch):
    get = Mock(side_effect=requests.Timeout('download timeout'))
    monkeypatch.setattr(requests, 'get', get)
    client = TmsClient('account', 'password', sleeper=lambda _: None)
    client.token = 'private-token'
    with pytest.raises(TmsError, match='download timeout'):
        client.download('https://tms-cos.mabangerp.com/file?sig=private')
    assert get.call_count == 1
    assert 'headers' not in get.call_args.kwargs and not get.call_args.kwargs['allow_redirects']


def test_execution_budgets(monkeypatch, tmp_path):
    result, client = execute(monkeypatch, tmp_path, [page([], 100001)])
    assert result['error']['code'] == 'record_limit'
    assert len(client.calls) == 1
    client = TmsClient('a', 'p', clock=lambda: 0)
    client.clock = lambda: 901
    with pytest.raises(TmsError, match='15 分钟'):
        client.check_budget()


def test_cli_retains_partial_artifact_without_auth_material(monkeypatch, tmp_path, capsys):
    import json
    from lxeskill import cli
    from lxeskill import business
    from services.agent_cli.mabang_tms import export_run
    output = tmp_path / 'partial.xlsx'
    output.write_bytes(workbook([values(record(1))]))
    monkeypatch.setattr(business, 'artifact_root', lambda: tmp_path)
    payload = {'success': False, 'status': 'partial_success', 'error': {'code': 'early_empty_page', 'message': 'actual error'},
               'artifacts': [{'path': str(output)}], 'auth_refresh_required': False}
    monkeypatch.setattr(export_run, 'run_with_events', lambda *args, **kwargs: payload)
    assert cli.main(['mabang-tms', 'export', 'run']) != 0
    result = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert result['ok'] is False and result['files']
    assert result['data']['status'] == 'partial_success'
