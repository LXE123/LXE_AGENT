from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import subprocess
import sys
from threading import Thread

import pytest
from lxeskill import cli
from lxeskill import cloud_status as cloud
from shared.infra import cloud_client as transport

CONTEXT = {"response_schema": "lxe.device-context.v1",
    "device": {"kind": "managed_device", "id": "fixture", "display_name": "Test PC", "wireguard_ip": "10.88.0.8"},
    "permission": {"assignment_version": 1,
        "profile": {"id": "fba", "revision": 1, "labels": {"zh-CN": "FBA", "en-US": "FBA"}},
        "grants": {"skill_types": ["amazon_fba"], "desktop_features": [], "server_capabilities": ["mabang_read"], "erp_actions": []}}}
CATALOG = {"data_source": "mabang", "apis": [{"id": "fixture"}]}


@contextmanager
def server(responses):
    calls = []
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            calls.append((self.path, dict(self.headers)))
            status, body, headers = responses[self.path]
            self.send_response(status)
            for name, value in headers.items():
                self.send_header(name, value)
            self.end_headers()
            self.wfile.write(body if isinstance(body, bytes) else json.dumps(body).encode())
        def log_message(self, *args):
            pass
    http = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    worker = Thread(target=http.serve_forever, daemon=True)
    worker.start()
    try:
        yield f'http://127.0.0.1:{http.server_port}', calls
    finally:
        http.shutdown()
        http.server_close()
        worker.join()


def responses():
    return {cloud.CONTEXT_PATH: (200, CONTEXT, {}), cloud.MABANG_PATH: (200, CATALOG, {})}


def test_success_does_not_initialize_desktop_workspace_or_send_credentials(monkeypatch, capsys):
    def forbidden(*args):
        pytest.fail('Cloud self check initialized business state')
    monkeypatch.setattr(cli, 'activate_project_workspace', forbidden)
    monkeypatch.setattr(cli, 'setup_logging', forbidden)
    monkeypatch.setattr(cli, 'load_catalog', forbidden)
    monkeypatch.setenv('LXE_DATA_SERVER_API_KEY', 'unused-data-secret')
    monkeypatch.setenv('LXE_DATA_SERVER_FALLBACK_API_KEY', 'unused-fallback-secret')
    monkeypatch.setenv('LXE_ERP_API_KEY', 'unused-erp-secret')
    monkeypatch.setenv('HTTP_PROXY', 'http://127.0.0.1:1')
    monkeypatch.setenv('http_proxy', 'http://127.0.0.1:1')
    with server(responses()) as (url, calls):
        assert cli.main(['cloud-status', '--server', url]) == 0
    result = json.loads(capsys.readouterr().out)
    assert result['protocol_version'] == '1'
    assert result['ok'] and result['data']['mabang_api_count'] == 1
    assert result['data']['upstream_queried'] is False
    assert [path for path, _ in calls] == [cloud.CONTEXT_PATH, cloud.MABANG_PATH]
    for _, headers in calls:
        assert headers['X-Lxe-Client'] == 'cli'
        assert not {h.lower() for h in headers} & {'authorization', 'cookie', 'proxy-authorization'}


def test_actual_cli_subprocess_without_business_credentials(tmp_path):
    env = {k: v for k, v in os.environ.items() if not (k.startswith('LXE_') or k.startswith('FEISHU_'))}
    env['PYTHONPATH'] = os.path.dirname(os.path.dirname(cloud.__file__))
    with server(responses()) as (url, calls):
        result = subprocess.run([sys.executable, '-m', 'lxeskill.cli', 'cloud-status', '--server', url],
                                cwd=tmp_path, env=env, capture_output=True, text=True, timeout=20)
    assert result.returncode == 0, result.stderr + result.stdout
    assert json.loads(result.stdout)['ok']
    assert len(calls) == 2
    assert not list(tmp_path.iterdir())


@pytest.mark.parametrize('stage', [cloud.CONTEXT_PATH, cloud.MABANG_PATH])
def test_real_denial_stops_without_retry_or_fallback(stage, monkeypatch):
    monkeypatch.setenv('LXE_DATA_SERVER_API_KEY', 'unused-secret')
    items = responses()
    items[stage] = (403, {'detail': {'code': 'business_capability_denied', 'message': 'actual diagnostic', 'token': 'private-fixture'}}, {})
    with server(items) as (url, calls):
        result, code = cloud.run_cloud_status(['--server', url])
    assert code == 4 and not result['ok']
    assert result['error']['code'] == 'business_capability_denied'
    assert 'actual diagnostic' in result['error']['message']
    assert 'private-fixture' not in str(result)
    assert len(calls) == (1 if stage == cloud.CONTEXT_PATH else 2)
    assert calls[-1][0] == stage
    if stage == cloud.MABANG_PATH:
        assert result['data']['device_context'] == CONTEXT
        assert result['data']['checks'][0]['ok'] is True


def test_redirect_is_not_followed():
    items = responses()
    items[cloud.CONTEXT_PATH] = (302, b'moved', {'Location': '/must-not-call'})
    with server(items) as (url, calls):
        result, code = cloud.run_cloud_status(['--server', url])
    assert code == 4 and result['error']['http_status'] == 302
    assert result['error']['message'] == 'moved'
    assert len(calls) == 1


@pytest.mark.parametrize('body', [b'not JSON', {'wrong': 'schema'}])
def test_invalid_success_preserves_actual_response(body):
    items = responses()
    items[cloud.CONTEXT_PATH] = (200, body, {})
    with server(items) as (url, calls):
        result, code = cloud.run_cloud_status(['--server', url])
    assert code == 4 and result['error']['code'] == 'cloud_invalid_response'
    assert ('not JSON' if isinstance(body, bytes) else 'wrong') in result['error']['message']
    assert len(calls) == 1


def test_response_is_bounded_and_explicitly_truncated(monkeypatch):
    monkeypatch.setattr(cloud, 'CloudClient', lambda url: transport.CloudClient(url, max_response_bytes=512))
    items = responses()
    items[cloud.CONTEXT_PATH] = (503, b'actual failure ' + b'x' * 1024, {})
    with server(items) as (url, _):
        result, code = cloud.run_cloud_status(['--server', url])
    assert code == 4 and 'actual failure' in result['error']['message']
    assert '[truncated]' in result['error']['message']


def test_connection_error_preserves_exception_and_has_no_retry(monkeypatch):
    class Broken:
        calls = 0
        def open(self, *args, **kwargs):
            self.calls += 1
            raise transport.URLError('connection fixture refused')
    broken = Broken()
    monkeypatch.setattr(transport, 'build_opener', lambda *args: broken)
    result, code = cloud.run_cloud_status(['--server', 'http://127.0.0.1:1'])
    assert code == 3 and broken.calls == 1
    assert 'connection fixture refused' in result['error']['message']


@pytest.mark.parametrize('args', [[], ['--bad'], ['--server'], ['--server', 'file:///tmp/x'],
    ['--server', 'http://user:password@example.com'], ['--server', 'http://host/api'],
    ['--server', 'http://host?token=private'], ['--server', 'http://host:invalid']])
def test_bad_configuration_fails_before_network(args, monkeypatch):
    monkeypatch.delenv('LXE_DATA_SERVER_URL', raising=False)
    monkeypatch.setattr(transport, 'build_opener', lambda *args: pytest.fail('unexpected network'))
    result, code = cloud.run_cloud_status(args)
    assert code == 2 and not result['ok']
    assert 'user:password' not in str(result)
    assert 'token=private' not in str(result)


def test_environment_server_and_help(monkeypatch):
    with server(responses()) as (url, _):
        monkeypatch.setenv('LXE_DATA_SERVER_URL', url)
        assert cloud.run_cloud_status([])[1] == 0
    assert cloud.run_cloud_status(['--help'])[1] == 0


def test_read_failure_preserves_received_http_status(monkeypatch):
    class BrokenResponse:
        code = 200
        closed = False
        def __enter__(self):
            return self
        def __exit__(self, *args):
            self.closed = True
        def read(self, limit):
            raise OSError('actual interrupted response')
    response = BrokenResponse()
    class Opener:
        def open(self, *args, **kwargs):
            return response
    monkeypatch.setattr(transport, 'build_opener', lambda *args: Opener())
    result, code = cloud.run_cloud_status(['--server', 'http://localhost'])
    assert code == 3 and response.closed
    assert result['data']['checks'][0]['http_status'] == 200
    assert result['error']['message'] == 'OSError: actual interrupted response'
