from copy import deepcopy
import json
import os
import subprocess
import sys

import pytest
from lxeskill import cli, cloud_context as cloud
from shared.infra import cloud_client as transport
from test_cloud_status import CONTEXT, server


def test_context_does_not_require_mabang_or_initialize_business_state(monkeypatch, capsys):
    def forbidden(*args):
        pytest.fail('unexpected business initialization')
    for name in ('activate_project_workspace', 'setup_logging', 'load_catalog'):
        monkeypatch.setattr(cli, name, forbidden)
    monkeypatch.setenv('HTTP_PROXY', 'http://127.0.0.1:1')
    monkeypatch.setenv('LXE_DATA_SERVER_API_KEY', 'unused-secret')
    context = deepcopy(CONTEXT)
    context['permission']['grants']['server_capabilities'] = []
    with server({cloud.CONTEXT_PATH: (200, context, {})}) as (url, calls):
        assert cli.main(['cloud-context', '--server', url]) == 0
    output = json.loads(capsys.readouterr().out)
    assert output['command'] == 'cloud-context' and output['protocol_version'] == '1'
    assert output['data']['device_context'] == context
    assert len(calls) == 1
    assert calls[0][1]['X-Lxe-Client'] == 'cli'
    assert not {'authorization', 'cookie', 'proxy-authorization'} & {h.lower() for h in calls[0][1]}


def test_actual_isolated_cli_process_does_not_create_database(tmp_path):
    env = {k: v for k, v in os.environ.items() if k.upper() in {'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE'}}
    with server({cloud.CONTEXT_PATH: (200, CONTEXT, {})}) as (url, calls):
        result = subprocess.run([sys.executable, '-I', '-B', '-X', 'utf8', '-m', 'lxeskill', 'cloud-context', '--server', url],
            env=env, cwd=tmp_path, capture_output=True, text=True, timeout=15)
    assert result.returncode == 0, result.stdout + result.stderr
    assert json.loads(result.stdout)['data']['device_context'] == CONTEXT
    assert len(calls) == 1 and not list(tmp_path.iterdir())


@pytest.mark.parametrize('status', [401, 403, 404, 503, 302])
def test_http_failure_preserves_actual_status_and_redacts_without_retry(status):
    body = {'detail': {'code': 'fixture_denied', 'message': 'actual upstream response', 'token': 'fixture-secret'}}
    with server({cloud.CONTEXT_PATH: (status, body, {'Location': '/do-not-follow'})}) as (url, calls):
        result, code = cloud.run_cloud_context(['--server', url])
    assert code == 4 and result['error']['http_status'] == status
    assert result['error']['code'] == 'fixture_denied'
    assert 'actual upstream response' in result['error']['message']
    assert 'fixture-secret' not in str(result) and len(calls) == 1


def test_nonzero_unassigned_version_and_no_inferred_grants():
    context = deepcopy(CONTEXT)
    context['permission'].update(profile=None, assignment_version=12)
    context['permission']['grants'] = dict.fromkeys(['skill_types','desktop_features','server_capabilities','erp_actions'], [])
    assert cloud.validate_device_context(context) == context
    context['permission']['grants']['skill_types'] = ['amazon_fba']
    with pytest.raises(ValueError, match='Unassigned'):
        cloud.validate_device_context(context)


@pytest.mark.parametrize('change', [
    lambda c: c.update(response_schema='unknown'),
    lambda c: c['permission'].update(assignment_version=True),
    lambda c: c['permission']['grants'].update(skill_types=['*', 'amazon_fba']),
    lambda c: c['permission']['grants'].update(skill_types=['a', 'a']),
    lambda c: c['device'].update(wireguard_ip='not-an-ip'),
    lambda c: c['permission']['profile'].update(revision=0),
])
def test_rejects_invalid_response(change):
    context=deepcopy(CONTEXT);change(context)
    with server({cloud.CONTEXT_PATH: (200, context, {})}) as (url, calls):
        result, code = cloud.run_cloud_context(['--server', url])
    assert code == 4 and result['error']['code'] == 'cloud_invalid_response'
    assert len(calls) == 1


def test_read_limit_and_timeout_configuration(monkeypatch):
    original=transport.CloudClient
    def small(url, **kwargs):
        assert kwargs['timeout'] == 10
        return original(url, timeout=10, max_response_bytes=64)
    monkeypatch.setattr(cloud, 'CloudClient', small)
    with server({cloud.CONTEXT_PATH: (200, CONTEXT, {})}) as (url, _):
        result, code = cloud.run_cloud_context(['--server',url])
    assert code == 4 and '[truncated]' in result['error']['message']


def test_help_and_invalid_url_without_requests(monkeypatch):
    monkeypatch.delenv('LXE_DATA_SERVER_URL', raising=False)
    assert cloud.run_cloud_context(['--help'])[1] == 0
    assert cloud.run_cloud_context([])[1] == 2
    assert cloud.run_cloud_context(['--server', 'http://user:secret@localhost'])[1] == 2
