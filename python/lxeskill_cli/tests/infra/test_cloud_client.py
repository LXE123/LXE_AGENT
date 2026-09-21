from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from threading import Thread

import pytest

from shared.infra import cloud_client as cloud


@contextmanager
def server(status=200, body=None, headers=None):
    calls = []

    class Handler(BaseHTTPRequestHandler):
        def handle_request(self):
            raw = self.rfile.read(int(self.headers.get('Content-Length', '0')))
            calls.append((self.command, self.path, dict(self.headers), raw))
            self.send_response(status)
            for name, value in (headers or {}).items():
                self.send_header(name, value)
            self.end_headers()
            self.wfile.write(body if isinstance(body, bytes) else json.dumps(body).encode())

        do_GET = handle_request
        do_POST = handle_request

        def log_message(self, *args):
            pass

    http = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    worker = Thread(target=lambda: http.serve_forever(poll_interval=0.01), daemon=True)
    worker.start()
    try:
        yield f'http://127.0.0.1:{http.server_port}', calls
    finally:
        http.shutdown()
        http.server_close()
        worker.join()


def test_post_json_is_utf8_without_credentials_or_environment_proxy(monkeypatch):
    for name in ('HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'):
        monkeypatch.setenv(name, 'http://127.0.0.1:1')
    monkeypatch.setenv('LXE_DATA_SERVER_API_KEY', 'unused-secret')
    monkeypatch.setenv('LXE_ERP_API_KEY', 'unused-erp-secret')
    # Success data is not silently redacted or subjected to diagnostic limits.
    payload = {'token': 'business-field', 'items': ['x' * 5000]}
    with server(body=payload) as (url, calls):
        response = cloud.CloudClient(url).request_json('POST', '/example', json_body={'sku': '\u7ec4\u5408'})
    assert response.status_code == 200 and response.json_valid and not response.truncated
    assert response.payload == payload and response.elapsed_ms >= 0
    assert len(calls) == 1
    method, path, headers, body = calls[0]
    assert (method, path) == ('POST', '/example')
    assert json.loads(body) == {'sku': '\u7ec4\u5408'}
    assert b'\\u' not in body
    assert headers['X-Lxe-Client'] == 'cli'
    assert headers['Content-Type'] == 'application/json'
    assert not {'authorization', 'cookie', 'proxy-authorization'} & {key.lower() for key in headers}


@pytest.mark.parametrize('status,body,valid', [(403, {'detail': {'code': 'denied'}}, True),
    (429, b'actual rate limit', False), (503, b'actual upstream failure', False),
    (200, [1, 2], True), (200, b'not JSON', False)])
def test_response_is_returned_without_business_interpretation_or_retry(status, body, valid):
    with server(status=status, body=body) as (url, calls):
        result = cloud.CloudClient(url).request_json('GET', '/example')
    assert len(calls) == 1 and result.status_code == status
    assert result.json_valid is valid
    assert result.payload == (body.decode() if isinstance(body, bytes) else body)


@pytest.mark.parametrize('status', [301, 302, 303, 307, 308])
def test_external_redirect_never_reaches_target(status):
    with server(body={'unexpected': True}) as (target, target_calls):
        with server(status, b'moved', {'Location': target + '/secret-target'}) as (url, calls):
            result = cloud.CloudClient(url).request_json('POST', '/example', json_body={})
    assert result.status_code == status and result.payload == 'moved'
    assert len(calls) == 1 and target_calls == []


@pytest.mark.parametrize('path', ['http://example.com/x', '//example.com/x', '/a/../b',
    '/a/./b', '/a\\b', '/a?token=x', '/a#fragment', '/x\r\ny', '/%2fexample.com',
    '/%252e%252e/b', '/a/%5cb', '/%00', 'relative'])
def test_invalid_path_is_rejected_before_sending(path):
    with server() as (url, calls):
        with pytest.raises(ValueError):
            cloud.CloudClient(url).request_json('GET', path)
    assert calls == []


def test_get_body_unsupported_method_and_invalid_json_do_not_send():
    with server() as (url, calls):
        client = cloud.CloudClient(url)
        for method, body in [('GET', {}), ('DELETE', None), ('POST', {'bad': float('nan')})]:
            with pytest.raises(ValueError):
                client.request_json(method, '/example', json_body=body)
    assert calls == []


def test_response_limit_is_explicit_even_when_prefix_is_valid_json():
    with server(body=b'{}' + b' ' * 100) as (url, _):
        result = cloud.CloudClient(url, max_response_bytes=10).request_json('GET', '/example')
    assert result.truncated and result.json_valid
    assert '[truncated]' in cloud.diagnostic(result.payload, result.truncated)


def test_connection_error_preserves_diagnostic_and_timeout_without_retry(monkeypatch):
    class Broken:
        calls = []
        def open(self, request, timeout):
            self.calls.append(timeout)
            raise cloud.URLError('actual failure Bearer private-secret')
    broken = Broken()
    monkeypatch.setattr(cloud, 'build_opener', lambda *args: broken)
    with pytest.raises(cloud.CloudConnectionError) as caught:
        cloud.CloudClient('http://localhost', timeout=2.5).request_json('GET', '/example')
    assert broken.calls == [2.5]
    assert caught.value.elapsed_ms >= 0
    assert 'URLError' in str(caught.value) and 'actual failure' in str(caught.value)
    assert 'private-secret' not in str(caught.value)


def test_server_override_and_invalid_configuration(monkeypatch):
    monkeypatch.setenv('LXE_DATA_SERVER_URL', 'http://default:8000/')
    assert cloud.CloudClient.from_env().server_url == 'http://default:8000'
    assert cloud.CloudClient.from_env(server_url='http://explicit').server_url == 'http://explicit'
    for value in ('', 'http://u:secret@example.com', 'http://host/path', 'http://host?token=x'):
        with pytest.raises(ValueError):
            cloud.CloudClient.from_env(server_url=value)
    for options in ({'timeout': 0}, {'timeout': float('inf')}, {'max_response_bytes': 0}):
        with pytest.raises(ValueError):
            cloud.CloudClient('http://localhost', **options)


def test_diagnostic_redacts_without_replacing_actual_error(monkeypatch):
    monkeypatch.setenv('LXE_DATA_SERVER_API_KEY', 'configured-secret')
    value = {'detail': {'message': 'actual failure configured-secret', 'token': 'hidden'}, 'body': 'x' * 5000}
    safe = cloud.diagnostic(value)
    assert 'actual failure' in safe and '[REDACTED]' in safe and '[truncated]' in safe
    assert 'configured-secret' not in safe and 'hidden' not in safe
    assert value['detail']['token'] == 'hidden'
