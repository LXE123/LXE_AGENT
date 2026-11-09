from __future__ import annotations

from contextlib import closing, contextmanager
from datetime import date, datetime, time as daytime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import base64
import json
from pathlib import Path
import subprocess
import sys
import threading
from urllib.parse import parse_qs, urlsplit
from xml.dom import minidom
from xml.etree import ElementTree
from zipfile import ZipFile
from zoneinfo import ZoneInfo

import pytest
from openpyxl import Workbook, load_workbook
from PIL import Image

from services.yacang import client, workflow, queue
from services.yacang.contracts import Credentials, REPORTS, WAREHOUSES, normalize, tasks_for, task_key
from services.yacang.errors import YacangError, safe_remote_detail
from services.yacang.state import ExportState
from services.yacang.auth_state import YacangAuthState
from services.yacang.validation import INVENTORY_SALES_HEADERS, INVENTORY_LIST_HEADERS, WAREHOUSE_PRODUCTS_HEADERS
from shared.filesystem import filesystem_path


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
        if '创建日期' in headers:
            row[headers.index('创建日期')] = '2026-09-29 06:38:58'
        ws.append(row)
    stream = io.BytesIO()
    wb.save(stream)
    wb.close()
    return stream.getvalue()


def captcha_jpeg(size=(80, 30)):
    image = io.BytesIO()
    Image.new('RGB', size, 'white').save(image, format='JPEG')
    return image.getvalue()


def shared_strings_xlsx(data):
    """Model the platform package, including namespace declarations used by Excel."""
    spreadsheet = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
    content_types = 'http://schemas.openxmlformats.org/package/2006/content-types'
    relationships = 'http://schemas.openxmlformats.org/package/2006/relationships'
    with ZipFile(io.BytesIO(data)) as source:
        sheet = ElementTree.fromstring(source.read('xl/worksheets/sheet1.xml'))
        strings = []
        for cell in sheet.iter(f'{{{spreadsheet}}}c'):
            if cell.get('t') != 'inlineStr':
                continue
            inline = cell.find(f'{{{spreadsheet}}}is')
            strings.append(''.join(inline.itertext()))
            cell.remove(inline)
            cell.set('t', 's')
            ElementTree.SubElement(cell, f'{{{spreadsheet}}}v').text = str(len(strings) - 1)
        sheet.set('xmlns:mc', 'http://schemas.openxmlformats.org/markup-compatibility/2006')
        sheet.set('xmlns:x14ac', 'http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac')
        sheet.set('mc:Ignorable', 'x14ac')
        for row in sheet.iter(f'{{{spreadsheet}}}row'):
            row.set('spans', '1:16')
        shared = ElementTree.Element(f'{{{spreadsheet}}}sst', {'count': str(len(strings)), 'uniqueCount': str(len(strings))})
        for value in strings:
            ElementTree.SubElement(ElementTree.SubElement(shared, f'{{{spreadsheet}}}si'), f'{{{spreadsheet}}}t').text = value
        types = ElementTree.fromstring(source.read('[Content_Types].xml'))
        ElementTree.SubElement(types, f'{{{content_types}}}Override', {
            'PartName': '/xl/sharedStrings.xml',
            'ContentType': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml',
        })
        rels = ElementTree.fromstring(source.read('xl/_rels/workbook.xml.rels'))
        ElementTree.SubElement(rels, f'{{{relationships}}}Relationship', {
            'Type': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings',
            'Target': 'sharedStrings.xml', 'Id': 'rId99',
        })
        changed = {
            'xl/worksheets/sheet1.xml': ElementTree.tostring(sheet, encoding='utf-8'),
            '[Content_Types].xml': ElementTree.tostring(types, encoding='utf-8'),
            'xl/_rels/workbook.xml.rels': ElementTree.tostring(rels, encoding='utf-8'),
        }
        output = io.BytesIO()
        with ZipFile(output, 'w') as target:
            for member in source.infolist():
                target.writestr(member, changed.get(member.filename, source.read(member.filename)))
            target.writestr('xl/sharedStrings.xml', ElementTree.tostring(shared, encoding='utf-8'))
    return output.getvalue()


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
    YacangAuthState(Credentials.from_environment()).save_session(state['token'])
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
                status, payload = 200, {'status': 1, 'data': {'key': 'private-key', 'captcha': base64.b64encode(captcha_jpeg()).decode()}}
            elif parsed.path.endswith('/loginV3'):
                assert body['key'] == 'private-key' and body['verify_code']
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


def test_sales_delivery_preserves_platform_package_and_xml_namespaces(platform):
    platform['bad_file'] = shared_strings_xlsx(xlsx('inventory-sales', 'VN8806'))
    result = workflow.run(request(warehouses=['VN8806']))
    assert result['success'], result
    delivered = filesystem_path(result['artifacts'][0]['path'])
    with ZipFile(io.BytesIO(platform['bad_file'])) as original, ZipFile(delivered) as output:
        assert output.namelist() == original.namelist()
        for name in original.namelist():
            if name != 'xl/worksheets/sheet1.xml':
                assert output.read(name) == original.read(name)
        with minidom.parseString(output.read('xl/worksheets/sheet1.xml')) as document:
            assert document.documentElement.getAttribute('xmlns:x14ac') == 'http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac'
            assert document.documentElement.getAttribute('mc:Ignorable') == 'x14ac'
            rows = document.getElementsByTagNameNS('*', 'row')
            assert len(rows) == 2
            assert all(row.getAttribute('spans') == '1:15' for row in rows)
    with closing(load_workbook(delivered, read_only=True, data_only=True)) as output:
        assert tuple(next(output.active.values)) == INVENTORY_SALES_HEADERS[:-1]


def test_sales_delivery_rejects_unexpected_dimensions_without_publishing(platform, env):
    stream = io.BytesIO()
    with ZipFile(io.BytesIO(xlsx('inventory-sales', 'VN8806'))) as original, ZipFile(stream, 'w') as changed:
        for member in original.infolist():
            data = original.read(member.filename)
            if member.filename == 'xl/worksheets/sheet1.xml':
                assert b'ref="A1:P2"' in data
                data = data.replace(b'ref="A1:P2"', b'ref="A1:Q2"')
            changed.writestr(member, data)
    platform['bad_file'] = stream.getvalue()
    result = workflow.run(request(warehouses=['VN8806']))
    assert not result['success'] and not result['artifacts']
    assert '原始报表列范围不是预期的 A1:P' in result['error']['message']
    assert not list(env.rglob('*.xlsx'))
    assert not list(env.rglob('.*.xlsx'))


def test_sales_rewrite_failure_discards_partial_file(platform, env, monkeypatch):
    original_write = Path.write_bytes

    def partial_write(path, data):
        if path.suffix == '.xlsx' and path.name.startswith('.'):
            original_write(path, b'partial workbook')
            raise OSError('simulated disk full while saving sales')
        return original_write(path, data)

    monkeypatch.setattr(Path, 'write_bytes', partial_write)
    result = workflow.run(request(warehouses=['VN8806']))
    assert not result['success'] and not result['artifacts']
    assert 'simulated disk full while saving sales' in result['error']['message']
    assert not list(env.rglob('*.xlsx'))


@pytest.mark.parametrize('status', [401, 403, 429, 500])
def test_global_failure_stops_remaining_tasks_and_preserves_error(platform, status):
    platform['reject'][REPORTS['inventory-sales'][1]] = (status, {'msg': 'actual denial test-password private-token'})
    result = workflow.run(request())
    assert not result['success'] and not result['artifacts']
    assert len(submits(platform)) == 1
    assert 'actual denial' in result['error']['message']
    assert 'test-password' not in json.dumps(result) and 'private-token' not in json.dumps(result)
    assert sum(t['status'] == 'not_run' for t in result['tasks']) == 3
    if status == 401:
        assert result['error']['code'] == 'login_required'
        assert result['tasks'][0]['submitted_in_run'] is True
        assert YacangAuthState(Credentials.from_environment()).status()['status'] == 'missing'


@pytest.mark.parametrize('require_fresh', [False, True])
def test_unknown_submit_recovers_queue_and_honors_fresh_requirement(platform, require_fresh):
    endpoint = REPORTS['inventory-sales'][1]
    platform['reject'][endpoint] = (500, {'msg': 'submit result unknown'})
    first = workflow.run(request(warehouses=['MY8801']))
    assert first['error']['code'] == 'submit_unknown'
    platform['rows'].append({'id': 'late', 'name': '库存动销导出', 'type': '10',
                            'param_where': json.dumps([['warehouse_id', '=', 26]]), 'path': platform['origin'] + '/file-late.xlsx'})
    platform['files']['/file-late.xlsx'] = xlsx('inventory-sales', 'MY8801', empty=True)
    del platform['reject'][endpoint]
    result = workflow.run(request(warehouses=['MY8801']), require_fresh=require_fresh)
    assert result['success'], result
    assert len(submits(platform)) == 1 + require_fresh
    assert result['artifacts'][0]['row_count'] == int(require_fresh)


def test_fresh_export_stops_if_previous_task_cannot_be_checked(platform):
    endpoint = REPORTS['inventory-sales'][1]
    platform['reject'][endpoint] = (500, {'msg': 'submit result unknown'})
    assert workflow.run(request(warehouses=['MY8801']))['error']['code'] == 'submit_unknown'
    del platform['reject'][endpoint]
    platform['reject']['/sys/customer/downPath/list'] = (500, {'msg': 'queue unavailable'})
    result = workflow.run(request(warehouses=['MY8801']), require_fresh=True)
    assert not result['success']
    assert 'submitted_in_run' not in result['tasks'][0]
    assert len(submits(platform)) == 1
    platform['reject'].pop('/sys/customer/downPath/list')
    platform['rows'].append({'id': 'late', 'name': '库存动销导出', 'type': '10',
                             'param_where': json.dumps([['warehouse_id', '=', 26]]), 'path': platform['origin'] + '/file-late.xlsx'})
    platform['files']['/file-late.xlsx'] = xlsx('inventory-sales', 'MY8801')
    assert workflow.run(request(warehouses=['MY8801']), require_fresh=True)['success']
    assert len(submits(platform)) == 2


def test_local_download_failure_preserves_partial_cli_files(platform, capsys):
    from lxeskill import cli
    platform['reject']['/file1.xlsx'] = (500, 'actual download failure')
    assert cli.main(["yacang", "reports", "export", '--report', 'inventory-sales', '--warehouse', 'MY8801', '--warehouse', 'PH8805']) != 0
    result = json.loads(capsys.readouterr().out.splitlines()[-1])
    assert not result['ok'] and result['data']['status'] == 'partial_success'
    assert len(result['files']) == 1 and filesystem_path(result['files'][0]).is_file()
    with closing(load_workbook(filesystem_path(result['files'][0]), read_only=True, data_only=True)) as output:
        assert tuple(next(output.active.values)) == INVENTORY_SALES_HEADERS[:-1]
    assert 'recovery' not in result
    assert 'actual download failure' in result['error']['message']


@pytest.mark.parametrize('bad_file', [b'<html>not xlsx</html>', xlsx('inventory-sales', 'VN8806')])
def test_invalid_file_not_published(platform, bad_file):
    platform['bad_file'] = bad_file
    result = workflow.run(request(warehouses=['MY8801']))
    assert not result['success'] and not result['artifacts']


def test_missing_local_login_state_stops_before_contact(platform):
    YacangAuthState(Credentials.from_environment()).clear()
    result = workflow.run(request())
    assert not result['success'] and not submits(platform)
    assert not platform['calls']
    assert result['error']['code'] == 'login_required'


def test_download_401_does_not_invalidate_erp_session(platform):
    platform['reject']['/file1.xlsx'] = (401, 'actual signed download denial')
    result = workflow.run(request(warehouses=['MY8801', 'PH8805']))
    assert result['error']['code'] == 'http_error'
    assert 'HTTP 401' in result['error']['message']
    assert 'actual signed download denial' in result['error']['message']
    assert result['status'] == 'partial_success' and len(result['artifacts']) == 1
    assert result['artifacts'][0]['warehouse'] == 'PH8805'
    assert YacangAuthState(Credentials.from_environment()).session() == platform['token']
    download = next(call for call in platform['calls'] if call[1] == '/file1.xlsx')
    assert not {'Token', 'token', 'Cookie', 'Authorization'} & download[3].keys()


@pytest.mark.parametrize('params', [None, {}, {'reports': []}, {'reports': ['bad']},
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
    YacangAuthState(Credentials.from_environment()).save_session(platform['token'])
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


def test_long_chinese_path_delivered_by_cli(platform, env, monkeypatch, capsys):
    from lxeskill import cli
    from shared import workspace
    root = env / ('中文 输出目录' * 10) / ('nested' * 10)
    original_activate = cli.activate_project_workspace
    def activate():
        result = original_activate()
        workspace._artifact_root = root
        return result
    monkeypatch.setattr(cli, 'activate_project_workspace', activate)
    params = request(warehouses=['MY8801'])['params']
    assert cli.main(["yacang", "reports", "export", *cli_options(params)]) == 0
    result = json.loads(capsys.readouterr().out.splitlines()[-1])
    assert result['ok'], result
    artifact = result['data']['artifacts'][0]
    assert len(artifact['path']) > 260
    assert not artifact['path'].startswith('\\\\?\\')
    assert Path(artifact['path']).is_relative_to(root)
    assert filesystem_path(artifact['path']).read_bytes().startswith(b'PK')
    assert result['files'] == [artifact['path']]
    assert list(filesystem_path(artifact['path']).parent.iterdir()) == [filesystem_path(artifact['path'])]
    assert not list(filesystem_path(root).rglob('.*.xlsx'))


def test_cleanup_failure_retains_original_error_and_partial_files(platform, monkeypatch, capsys):
    from lxeskill import cli
    platform['reject']['/file2.xlsx'] = (500, 'actual download failure test-password')
    original_unlink = Path.unlink
    def fail_cleanup(path, *args, **kwargs):
        if path.name.startswith('.') and '菲律宾' in path.name:
            raise PermissionError('actual cleanup failure test-password')
        return original_unlink(path, *args, **kwargs)
    monkeypatch.setattr(Path, 'unlink', fail_cleanup)
    params = request(warehouses=['MY8801', 'PH8805'])['params']
    assert cli.main(["yacang", "reports", "export", *cli_options(params)]) != 0
    result = json.loads(capsys.readouterr().out.splitlines()[-1])
    assert result['data']['status'] == 'partial_success'
    error = result['data']['error']
    assert error['code'] == 'http_error'
    assert 'actual download failure' in error['message']
    assert 'actual cleanup failure' in error['cleanup_error']
    assert 'test-password' not in json.dumps(result)
    assert len(result['files']) == 1
    assert filesystem_path(result['files'][0]).is_file()


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


def test_captcha_image_login_persists_without_exposing_secrets(platform):
    auth = YacangAuthState(Credentials.from_environment())
    auth.images.mkdir(parents=True)
    orphan = auth.images / ('challenge-' + 'a' * 32 + '.jpg')
    orphan.write_bytes(captcha_jpeg())
    prepared = workflow.login_action('prepare', {})
    assert not orphan.exists()
    assert prepared['success'] and Path(prepared['image_path']).read_bytes() == captcha_jpeg()
    with Image.open(prepared['image_path']) as image:
        image.verify()
    assert 'private-key' not in json.dumps(prepared)
    submitted = workflow.login_action('submit', {'challenge_id': prepared['challenge_id'], 'captcha_code': 'Ab9x'})
    assert submitted['success'] and submitted['persisted']
    assert 'private-token' not in json.dumps(submitted)
    call = next(c for c in platform['calls'] if c[1].endswith('/loginV3'))
    assert call[4] == {'mobile': 'test-mobile', 'password': 'test-password', 'verify_code': 'Ab9x', 'key': 'private-key', 'lang': 'zh-cn'}
    assert YacangAuthState(Credentials.from_environment()).session() == 'private-token'
    export = workflow.run(request(warehouses=['MY8801']))
    assert export['success']
    assert next(c for c in platform['calls'] if c[1] in {r[1] for r in REPORTS.values()})[3].get('token') == 'private-token'


MALFORMED_CAPTCHA = ('{"status":1,"message":"actual malformed response%s",'
                     '"data":{"key":"private-key","captcha":"synthetic-image-base64')
MALFORMED_LOGIN = '{"status":0,"data":{"token":"reflected-secret"},"message":"denied reflected-secret",'


@pytest.mark.parametrize('status,payload,code,details', [
    (200, 'not json', 'invalid_response', ('not json',)),
    (200, {'status': 1, 'data': {}}, 'invalid_captcha', ('data.key/captcha',)),
    (200, {'status': 1, 'data': {'key': 'private-key'}, 'msg': 'actual missing image reason'},
     'invalid_captcha', ('actual missing image reason',)),
    (200, {'status': 0, 'data': {'key': 'private-key', 'captcha': 'private-image'},
           'msg': 'actual captcha unavailable'}, 'remote_error', ('actual captcha unavailable',)),
    (200, MALFORMED_CAPTCHA % '', 'invalid_response', ('actual malformed response', 'Unterminated string')),
    (403, MALFORMED_CAPTCHA % '', 'forbidden', ('actual malformed response',)),
    (200, MALFORMED_CAPTCHA % ('x' * 2100) + '", invalid}',
     'invalid_response', ('actual malformed response', 'Expecting property name')),
    pytest.param(200, b'\xff\xd8\xfftruncated', 'invalid_captcha', ('UnidentifiedImageError',), id='truncated-image'),
    pytest.param(200, captcha_jpeg((2001, 2000)), 'invalid_captcha', ('4000000',), id='oversized-image'),
])
def test_prepare_preserves_redacted_actual_response_errors(platform, status, payload, code, details):
    if isinstance(payload, bytes):
        payload = {'status': 1, 'data': {'key': 'private-key', 'captcha': base64.b64encode(payload).decode()}}
    platform['reject']['/sys/customer/verify'] = (status, payload)
    result = workflow.login_action('prepare', {})
    assert not result['success'] and result['error']['code'] == code
    assert all(detail in result['error']['message'] for detail in details)
    assert all(secret not in json.dumps(result) for secret in ('private-key', 'private-image', 'synthetic-image-base64'))
    assert not submits(platform)


@pytest.mark.parametrize('status,payload,details', [
    (200, {'status': 0, 'data': {'token': 'reflected-secret'}, 'message': 'actual denial reflected-secret'},
     ('actual denial',)),
    (200, MALFORMED_LOGIN, ('Expecting property name', '/sys/customer/loginV3: HTTP 200')),
    (403, MALFORMED_LOGIN, ('Expecting property name', '/sys/customer/loginV3: HTTP 403')),
    (200, '{"status":0,"data":{"token":"\\ud800"},"message":"actual denial",',
     ('Expecting property name', '/sys/customer/loginV3: HTTP 200')),
    (200, {'status': 1, 'data': {'unexpected': 'actual payload'}}, ('actual payload',)),
])
def test_login_failures_preserve_diagnostics_without_secrets(platform, status, payload, details):
    prepared = workflow.login_action('prepare', {})
    platform['reject']['/sys/customer/loginV3'] = (status, payload)
    result = workflow.login_action('submit', {'challenge_id': prepared['challenge_id'], 'captcha_code': 'Ab9x'})
    assert not result['success'] and not result['persisted']
    assert all(detail in result['error']['message'] for detail in details)
    assert all(secret not in json.dumps(result) for secret in ('reflected-secret', '\\ud800', 'private-key', 'Ab9x'))


def test_diagnostic_handles_unpaired_surrogate_secret():
    assert safe_remote_detail('token value \\ud800', secrets=('\ud800',)) == 'token value [REDACTED]'


@pytest.mark.parametrize('action,method,reply', [
    ('prepare', 'prepare_login', ('private-key', captcha_jpeg())),
    ('submit', 'login', 'private-token'),
])
def test_clear_during_login_prevents_old_state_from_returning(env, monkeypatch, action, method, reply):
    auth = YacangAuthState(Credentials.from_environment())
    challenge = auth.prepare('private-key', captcha_jpeg())
    def clear(*args):
        auth.clear()
        return reply
    monkeypatch.setattr(client.YacangClient, method, clear)
    result = workflow.login_action(action, {'challenge_id': challenge['challenge_id'], 'captcha_code': 'Ab9x'})
    assert not result['success'] and not result['persisted']
    assert result['login_succeeded'] == (action == 'submit')
    assert result['error']['code'] == 'login_cleared'
    assert auth.status()['status'] == 'missing'
    assert not list(auth.root.glob('challenge-*.json'))
    assert not list(auth.images.glob('challenge-*.jpg'))


@pytest.mark.parametrize('times_out', [False, True])
def test_login_waits_for_account_and_consumes_challenge_once(env, monkeypatch, times_out):
    credentials = Credentials.from_environment()
    auth = YacangAuthState(credentials)
    challenge = auth.prepare('private-key', captcha_jpeg())
    calls = []
    def login(self, key, code):
        calls.append((key, code))
        if times_out:
            raise TimeoutError('actual timeout')
        return 'private-token'
    monkeypatch.setattr(client.YacangClient, 'login', login)
    args = {'challenge_id': challenge['challenge_id'], 'captcha_code': 'Ab9x'}
    with ExportState(credentials.account_id).run_lock():
        rejected = workflow.login_action('submit', args)
    assert not rejected['success'] and not calls
    result = workflow.login_action('submit', args)
    if times_out:
        assert 'actual timeout' in result['error']['message']
    else:
        assert result['persisted']
    assert workflow.login_action('submit', args)['error']['code'] == 'challenge_unavailable'
    assert calls == [('private-key', 'Ab9x')]


@pytest.mark.parametrize('state,detail', [([], 'list'), ({}, 'fingerprint'), ({'fingerprint': 'current'}, 'token')])
def test_malformed_login_state_reports_actual_shape(env, state, detail):
    auth = YacangAuthState(Credentials.from_environment())
    auth.root.mkdir(parents=True)
    if isinstance(state, dict) and state.get('fingerprint') == 'current':
        state['fingerprint'] = auth.fingerprint
    auth.session_path.write_text(json.dumps(state), encoding='utf-8')
    result = workflow.login_action('status', {})
    assert not result['success']
    assert result['error']['code'] == 'auth_state_unavailable'
    assert detail in result['error']['message']
    assert auth.session_path.exists()


def test_failed_challenge_image_write_cleans_partial_file(env, monkeypatch):
    from services.yacang import auth_state
    auth = YacangAuthState(Credentials.from_environment())
    original = auth_state._restrict_permissions
    def fail_image(path, mode):
        if path.suffix == '.jpg':
            raise OSError('actual image permission failure')
        original(path, mode)
    monkeypatch.setattr(auth_state, '_restrict_permissions', fail_image)
    with pytest.raises(OSError, match='actual image permission failure'):
        auth.prepare('private-key', captcha_jpeg())
    assert not list(auth.images.glob('challenge-*.jpg'))
    assert not list(auth.root.glob('challenge-*.json'))


def test_challenge_cleanup_preserves_read_error_and_existing_files(env, monkeypatch):
    auth = YacangAuthState(Credentials.from_environment())
    challenge = auth.prepare('private-key', captcha_jpeg())
    path = auth.root / (challenge['challenge_id'] + '.json')
    read_text = Path.read_text
    def deny_challenge(self, *args, **kwargs):
        if self == path:
            raise PermissionError('actual challenge read failure')
        return read_text(self, *args, **kwargs)
    monkeypatch.setattr(Path, 'read_text', deny_challenge)
    with pytest.raises(PermissionError, match='actual challenge read failure'):
        auth.prepare('another-key', captcha_jpeg())
    assert path.exists() and Path(challenge['image_path']).exists()


def test_concurrent_same_account_stops_before_second_login(platform):
    state = ExportState(Credentials.from_environment().account_id)
    with state.run_lock():
        result = workflow.run(request())
    assert not result['success'] and not platform['calls']
    assert 'InterProcessLockTimeout' in result['error']['message']


def cli_options(params):
    names = {"inventory-sales": "inventory-sales", "inventory-current-snapshot": "inventory", "warehouse-products": "products"}
    args = [arg for report in params["reports"] for arg in ("--report", names[report])]
    args += [arg for warehouse in params.get("warehouses", []) for arg in ("--warehouse", warehouse)]
    if "created_date" in params:
        args += ["--created-from", params["created_date"]["start_date"], "--created-to", params["created_date"]["end_date"]]
    return args
