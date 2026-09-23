from __future__ import annotations

from contextlib import contextmanager
from datetime import date, datetime, time as daytime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
from urllib.parse import parse_qs, urlsplit
from zoneinfo import ZoneInfo

import pytest
from openpyxl import Workbook

from services.yacang import client, workflow, queue
from services.yacang.contracts import Credentials, REPORTS, WAREHOUSES, normalize, tasks_for, task_key
from services.yacang.errors import YacangError
from services.yacang.state import ExportState
from services.yacang.validation import INVENTORY_SALES_HEADERS, INVENTORY_LIST_HEADERS, WAREHOUSE_PRODUCTS_HEADERS


def xlsx(report, warehouse, empty=False):
    wb = Workbook()
    ws = wb.active
    headers = {'inventory-sales': INVENTORY_SALES_HEADERS, 'inventory-current-snapshot': INVENTORY_LIST_HEADERS,
               'warehouse-products': WAREHOUSE_PRODUCTS_HEADERS}[report]
    ws.append(headers)
    if not empty:
        row = [0] * len(headers)
        if '仓库' in headers:
            row[headers.index('仓库')] = warehouse
        if '创建时间' in headers:
            row[headers.index('创建时间')] = '2026-09-23 10:00'
        ws.append(row)
    stream = io.BytesIO()
    wb.save(stream)
    wb.close()
    return stream.getvalue()


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setenv('LXE_DATA_ROOT', str(tmp_path))
    monkeypatch.setenv('LXE_SQLITE_DB_PATH', str(tmp_path / 'db/lxeskill.sqlite3'))
    monkeypatch.setenv('LXE_YACANG_MOBILE', 'test-mobile')
    monkeypatch.setenv('LXE_YACANG_PASSWORD', 'test-password')
    from shared import workspace
    monkeypatch.setattr(workspace, '_artifact_root', tmp_path / 'artifacts')
    return tmp_path


@pytest.fixture
def platform(env, monkeypatch):
    state = {'calls': [], 'rows': [], 'files': {}, 'empty': False, 'reject': {}, 'hidden_date': False, 'token': 'private-token'}
    @contextmanager
    def slot(self):
        yield
    monkeypatch.setattr(ExportState, 'request_slot', slot)
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass
        def do_POST(self):
            self.do_GET()
        def do_GET(self):
            parsed = urlsplit(self.path)
            params = {k: v[0] for k, v in parse_qs(parsed.query).items()}
            body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))) or b'{}')
            state['calls'].append((self.command, parsed.path, params, dict(self.headers), body))
            if parsed.path in state['reject']:
                status, payload = state['reject'][parsed.path]
            elif parsed.path.endswith('/verify'):
                status, payload = 200, {'status': 1, 'data': {'key': 'private-key', 'code': 'wr'}}
            elif parsed.path.endswith('/loginV3'):
                assert body['key'] == 'private-key' and body['verify_code'] == 'wr'
                status, payload = 200, {'status': 1, 'data': {'token': state['token']}}
            elif parsed.path.endswith('/downPath/list'):
                status, payload = 200, {'status': 1, 'data': {'list': state['rows']}}
            elif parsed.path in state['files']:
                status, payload = 200, state['files'][parsed.path]
            else:
                report = next(k for k, v in REPORTS.items() if v[1] == parsed.path)
                warehouse = next((k for k, v in WAREHOUSES.items() if str(v[0]) == params.get('warehouse_id')), None)
                terms = [['warehouse_id', '=', params['warehouse_id']]] if warehouse else []
                if params.get('create_time'):
                    start, end = params['create_time'].split(' - ')
                    def epoch(day):
                        return int(datetime.combine(day, daytime.min, ZoneInfo('Asia/Shanghai')).timestamp())
                    terms += [['create_time', '>=', epoch(date.fromisoformat(start))], ['create_time', '<', epoch(date.fromisoformat(end) + timedelta(days=1))]]
                if state['hidden_date']:
                    terms.append(['create_time', '>=', 1])
                if report == 'warehouse-products':
                    terms.append(['status', '=', '1'])
                if report == 'inventory-current-snapshot':
                    terms = {'warehouse_id': params['warehouse_id'], 'goods_sku_condition': '2', 'user_id': 'fixture-user'}
                number = len(state['rows']) + 1
                file_path = f'/file{number}.xlsx'
                state['files'][file_path] = state.get('bad_file', xlsx(report, warehouse, state['empty']))
                state['rows'].append({'id': str(number), 'type': REPORTS[report][2], 'name': REPORTS[report][3],
                                      'param_where': json.dumps(terms), 'path': state['origin'] + file_path + '?signature=private-signature'})
                status, payload = 200, {'status': 1, 'request_id': str(number)}
            self.send_response(status)
            self.end_headers()
            self.wfile.write(payload if isinstance(payload, bytes) else payload.encode() if isinstance(payload, str) else json.dumps(payload).encode())
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    state['origin'] = f'http://127.0.0.1:{server.server_port}'
    monkeypatch.setattr(client, 'API_ORIGIN', state['origin'])
    monkeypatch.setattr(client, 'trusted_download', lambda url: url.startswith(state['origin'] + '/file'))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield state
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def request(reports=None, warehouses=None, created=None):
    params = {'reports': reports or ['inventory-sales']}
    if warehouses is not None:
        params['warehouses'] = warehouses
    if created is not None:
        params['created_date'] = created
    return {'params': params}


def submits(platform):
    return [call for call in platform['calls'] if call[1] in {r[1] for r in REPORTS.values()}]


def test_all_reports_nine_original_files_single_login_and_new_runs(platform):
    result = workflow.run(request(list(REPORTS)))
    assert result['success'], result
    assert len(result['artifacts']) == 9
    assert len(submits(platform)) == 9
    assert sum(c[1].endswith('loginV3') for c in platform['calls']) == 1
    assert not any('create_time' in c[2] for c in submits(platform))
    assert result['params']['created_date'] is None
    for index, artifact in enumerate(result['artifacts'], 1):
        assert Path(artifact['path']).read_bytes() == platform['files'][f'/file{index}.xlsx']
        assert artifact['row_count'] == 1 and artifact['sheet_names']
    for call in platform['calls']:
        if call[1].startswith('/file'):
            assert not {'Token', 'token', 'Cookie', 'Authorization'} & call[3].keys()
    assert all(secret not in json.dumps(result) for secret in ['test-password', 'private-token', 'private-key', 'private-signature'])
    again = workflow.run(request(warehouses=['MY8801']))
    assert again['success'] and len(submits(platform)) == 10
    assert Path(again['artifacts'][0]['path']).parent != Path(result['artifacts'][0]['path']).parent


def test_explicit_creation_dates_and_empty_file(platform):
    platform['empty'] = True
    result = workflow.run(request(warehouses=['VN8806'], created={'start_date': '2026-01-01', 'end_date': '2026-09-23'}))
    assert result['success'], result
    assert submits(platform)[0][2]['create_time'] == '2026-01-01 - 2026-09-23'
    assert result['artifacts'][0]['row_count'] == 0
    assert result['artifacts'][0]['notice']


def test_platform_hidden_date_filter_is_not_reported_as_all_goods(platform):
    platform['hidden_date'] = True
    result = workflow.run(request(warehouses=['MY8801']))
    assert not result['success']
    assert result['error']['code'] == 'date_range_required'
    assert not result['artifacts'] and len(submits(platform)) == 1


@pytest.mark.parametrize('status', [401, 403, 429, 500])
def test_global_failure_stops_remaining_tasks_and_preserves_error(platform, status):
    platform['reject'][REPORTS['inventory-sales'][1]] = (status, {'msg': 'actual denial test-password private-token'})
    result = workflow.run(request())
    assert not result['success'] and not result['artifacts']
    assert len(submits(platform)) == 1
    assert 'actual denial' in result['error']['message']
    assert 'test-password' not in json.dumps(result) and 'private-token' not in json.dumps(result)
    assert sum(t['status'] == 'not_run' for t in result['tasks']) == 3


def test_unknown_submit_resumes_queue_without_resubmitting(platform):
    endpoint = REPORTS['inventory-sales'][1]
    platform['reject'][endpoint] = (500, {'msg': 'submit result unknown'})
    first = workflow.run(request(warehouses=['MY8801']))
    assert first['error']['code'] == 'submit_unknown'
    platform['rows'].append({'id': 'late', 'name': '库存动销导出', 'type': '10',
                            'param_where': json.dumps([['warehouse_id', '=', 26]]), 'path': platform['origin'] + '/file-late.xlsx'})
    platform['files']['/file-late.xlsx'] = xlsx('inventory-sales', 'MY8801')
    result = workflow.run(request(warehouses=['MY8801']))
    assert result['success'], result
    assert len(submits(platform)) == 1


def test_local_download_failure_preserves_partial_cli_files(platform, capsys):
    from lxeskill import cli
    platform['reject']['/file1.xlsx'] = (500, 'actual download failure')
    assert cli.main(['yacang', 'export', 'run', '--params', json.dumps(request(warehouses=['MY8801', 'PH8805'])['params'])]) != 0
    result = json.loads(capsys.readouterr().out.splitlines()[-1])
    assert not result['ok'] and result['data']['status'] == 'partial_success'
    assert len(result['files']) == 1 and Path(result['files'][0]).is_file()
    assert 'recovery' not in result
    assert 'actual download failure' in result['error']['message']


@pytest.mark.parametrize('bad_file', [b'<html>not xlsx</html>', xlsx('inventory-sales', 'VN8806')])
def test_invalid_file_not_published(platform, bad_file):
    platform['bad_file'] = bad_file
    result = workflow.run(request(warehouses=['MY8801']))
    assert not result['success'] and not result['artifacts']


@pytest.mark.parametrize('payload', ['not json', {'status': 1, 'data': {}}, {'status': 0, 'msg': 'captcha unavailable'}])
def test_bad_login_stops_without_export(platform, payload):
    platform['reject']['/sys/customer/verify'] = (200, payload)
    result = workflow.run(request())
    assert not result['success'] and not submits(platform)
    assert len(platform['calls']) == 1


def test_missing_token_preserves_diagnostic(platform):
    platform['reject']['/sys/customer/loginV3'] = (200, {'status': 1, 'data': {'unexpected': 'actual payload'}})
    result = workflow.run(request())
    assert 'actual payload' in result['error']['message'] and not submits(platform)


@pytest.mark.parametrize('params', [None, {}, {'reports': []}, {'reports': ['bad']}, {'reports': ['inventory-sales'], 'warehouses': []},
    {'reports': ['inventory-sales'], 'created_date': {'start_date': '2026-01-01'}},
    {'reports': ['inventory-sales'], 'created_date': {'start_date': '2026-02-30', 'end_date': '2026-03-01'}},
    {'reports': ['warehouse-products'], 'warehouses': ['MY8801']}, {'reports': ['inventory-sales'], 'url': 'bad'}])
def test_invalid_params_do_not_contact_platform(platform, params):
    result = workflow.run({'params': params})
    assert not result['success'] and not platform['calls']


def test_account_isolation_and_cross_process_records(env):
    first, second = ExportState('one'), ExportState('two')
    task = tasks_for(normalize({'reports': ['inventory-sales']}))[0]
    key = task_key('one', task)
    first.begin(key, {'old'})
    assert second.pending(task_key('two', task)) is None
    child = subprocess.run([sys.executable, '-c', "from services.yacang.state import ExportState; import sys; assert ExportState('one').pending(sys.argv[1]) == {'old'}", key], capture_output=True, text=True)
    assert child.returncode == 0, child.stderr
    with first.task_lock(key):
        from shared.process_lock import InterProcessLockTimeout
        with pytest.raises(InterProcessLockTimeout):
            with second.task_lock(key):
                pass
    first.clear(key)
    assert first.pending(key) is None


@pytest.mark.parametrize('url,valid', [('https://oss-accelerate.seaya.cn/a.xlsx?signature=ok', True),
    ('https://evil.test/a.xlsx', False), ('http://oss-accelerate.seaya.cn/a.xlsx', False),
    ('https://user:pass@oss-accelerate.seaya.cn/a.xlsx', False), ('https://oss-accelerate.seaya.cn:99/a.xlsx', False)])
def test_download_url_boundary(url, valid):
    assert bool(client.trusted_download(url)) == valid


def test_redaction_happens_before_truncation():
    from services.yacang.errors import safe_remote_detail
    secret = 'x' * 3000
    result = safe_remote_detail('actual failure ' + secret + ' ' + 'z' * 3000, secrets=(secret,))
    assert 'actual failure' in result and 'x' * 10 not in result and result.endswith('[truncated]')


def test_queue_filters_use_report_specific_shapes_and_exclude_other_ranges():
    for report in REPORTS:
        task = tasks_for(normalize({'reports': [report]}))[0]
        terms = {'warehouse_id': '26', 'goods_sku_condition': '2', 'user_id': 'fixture-user'} if report == 'inventory-current-snapshot' else (
            [['user_id', '=', 'fixture-user'], ['status', '=', '1']] if report == 'warehouse-products' else [['warehouse_id', 'in', ['26']]])
        row = {'id': 'new', 'type': REPORTS[report][2], 'name': REPORTS[report][3], 'param_where': json.dumps(terms)}
        assert queue.matches(row, task)
        if isinstance(terms, dict):
            terms['goods_sku_condition'] = '1'
        else:
            terms.append(['sku', '=', 'unrequested-subset'])
        assert not queue.matches({**row, 'param_where': json.dumps(terms)}, task)
    task = tasks_for(normalize({'reports': ['warehouse-products']}))[0]
    row = {'type': '6', 'name': '资料导出', 'param_where': '[["status","=","0"]]'}
    assert not queue.matches(row, task)


def test_queue_never_uses_baseline_or_ambiguous_files():
    from types import SimpleNamespace
    from services.yacang.errors import safe_remote_detail
    task = tasks_for(normalize({'reports': ['inventory-sales']}))[0]
    row = {'id': 'old', 'type': '10', 'name': '库存动销导出', 'param_where': '[["warehouse_id","=",26]]', 'path': 'https://oss-accelerate.seaya.cn/old.xlsx'}
    api = SimpleNamespace(list_downloads=lambda: [row], diagnostic=safe_remote_detail)
    with pytest.raises(YacangError, match='超时'):
        queue.wait_for_file(api, task, {'old'}, timeout=0)
    api.list_downloads = lambda: [{**row, 'id': 'new1'}, {**row, 'id': 'new2'}]
    with pytest.raises(YacangError, match='多个新任务'):
        queue.wait_for_file(api, task, set(), timeout=0)


@pytest.mark.parametrize('payload', ['not json', [], {'request_id': 'unknown'}])
def test_invalid_submit_response_remains_pending(platform, payload):
    platform['reject'][REPORTS['inventory-sales'][1]] = (200, payload)
    result = workflow.run(request(warehouses=['MY8801']))
    assert result['error']['code'] == 'submit_unknown'
    credentials = Credentials.from_environment()
    task = tasks_for(normalize(request(warehouses=['MY8801'])['params']))[0]
    assert ExportState(credentials.account_id).pending(task_key(credentials.account_id, task)) == set()
    assert len(submits(platform)) == 1


@pytest.mark.parametrize('purpose,path,attempts', [('auth','/sys/customer/verify',1), ('submit',REPORTS['inventory-sales'][1],1), ('queue','/sys/customer/downPath/list',2)])
def test_only_readonly_queue_retries_network_timeout(env, monkeypatch, purpose, path, attempts):
    from requests import Timeout
    from contextlib import nullcontext
    from types import SimpleNamespace
    api = client.YacangClient(Credentials.from_environment(), SimpleNamespace(request_slot=nullcontext))
    calls = []
    def timeout(*args, **kwargs):
        calls.append(args)
        raise Timeout('actual read timeout test-password')
    monkeypatch.setattr(api.session, 'request', timeout)
    monkeypatch.setattr(client.time, 'sleep', lambda _: None)
    try:
        with pytest.raises(YacangError) as caught:
            api.request('GET', path, purpose=purpose)
        assert len(calls) == attempts
        assert 'actual read timeout' in str(caught.value) and 'test-password' not in str(caught.value)
        assert caught.value.code == ('submit_unknown' if purpose == 'submit' else 'network_error')
    finally:
        api.close()


def test_invalid_header_redacts_known_secrets_before_truncation(platform, monkeypatch):
    secret = 'p' * 3000
    monkeypatch.setenv('LXE_YACANG_PASSWORD', secret)
    wb = Workbook()
    wb.active.append([secret, 'invalid header'])
    buffer = io.BytesIO()
    wb.save(buffer)
    wb.close()
    platform['bad_file'] = buffer.getvalue()
    result = workflow.run(request(warehouses=['MY8801']))
    assert not result['success'] and not result['artifacts']
    assert '表头不匹配' in result['error']['message']
    assert 'p' * 10 not in json.dumps(result)


def test_state_rate_limit_is_account_scoped_and_contains_no_auth_material(env, monkeypatch):
    monkeypatch.setattr('services.yacang.state.time.sleep', lambda _: None)
    first, second = ExportState('one'), ExportState('two')
    first.cooldown()
    with pytest.raises(YacangError) as caught:
        with first.request_slot():
            pytest.fail('cooldown allowed a request')
    assert caught.value.code == 'rate_limited'
    with second.request_slot():
        pass
    raw = first.db.read_bytes()
    assert all(secret not in raw for secret in (b'test-mobile', b'test-password', b'private-token'))


def test_interprocess_request_lock_cannot_be_bypassed(env, monkeypatch):
    from shared.process_lock import interprocess_lock
    monkeypatch.setattr('services.yacang.state.time.sleep', lambda _: None)
    state = ExportState('one')
    with state.request_slot():
        script = """from shared.process_lock import interprocess_lock, InterProcessLockTimeout
import sys
try:
    with interprocess_lock(sys.argv[1], timeout_seconds=0):
        sys.exit(2)
except InterProcessLockTimeout:
    sys.exit(0)
"""
        result = subprocess.run([sys.executable, '-c', script, str(state.root / 'requests.lock')], capture_output=True, text=True)
        assert result.returncode == 0, result.stderr


def test_rejected_captcha_response_never_exposes_code(platform):
    platform['reject']['/sys/customer/verify'] = (200, {'status': 0, 'data': {'key': 'private-key', 'code': 'secret-captcha'}, 'msg': 'actual unavailable'})
    result = workflow.run(request())
    assert 'secret-captcha' not in json.dumps(result)
    assert 'actual unavailable' in result['error']['message']


def test_concurrent_same_account_stops_before_second_login(platform):
    state = ExportState(Credentials.from_environment().account_id)
    with state.run_lock():
        result = workflow.run(request())
    assert not result['success'] and not platform['calls']
    assert 'InterProcessLockTimeout' in result['error']['message']
