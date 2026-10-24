from contextlib import contextmanager
from types import SimpleNamespace

import pytest

from services.agent_cli._shared import browser_session as sessions


@pytest.mark.parametrize('strict', [False, True])
def test_workflow_session_forwards_explicit_attach_policy(tmp_path, monkeypatch, strict):
    observed = []
    driver = object()

    @contextmanager
    def store_session(store_id, **options):
        observed.append((store_id, options))
        yield SimpleNamespace(browser_oauth=store_id, browser_name='store',
                              download_path='', browser_path=''), driver

    monkeypatch.setattr(sessions, 'store_driver_session', store_session)
    options = {'strict_attach': True, 'target_host': 'sellercentral.amazon.com',
               'target_handle': 'verified-tab'} if strict else {}
    with sessions.browser_session(session_id='session-1', context={'store_id': 'store-1'},
                                  output_dir=tmp_path, **options) as session:
        assert session.driver is driver
        assert session.store_id == 'store-1'
    assert observed == [('store-1', options)]


def test_strict_workflow_session_preserves_attach_failure_without_retry(tmp_path, monkeypatch):
    calls = []

    @contextmanager
    def failed_session(store_id, **options):
        calls.append(options)
        raise RuntimeError('actual paired Selenium attach failure')
        yield

    monkeypatch.setattr(sessions, 'store_driver_session', failed_session)
    with pytest.raises(RuntimeError, match='actual paired Selenium attach failure'):
        with sessions.browser_session(session_id='session-1', context={'store_id': 'store-1'},
                                      output_dir=tmp_path, strict_attach=True,
                                      target_host='sellercentral.amazon.com'):
            pytest.fail('must not yield')
    assert calls == [{'strict_attach': True, 'target_host': 'sellercentral.amazon.com', 'target_handle': ''}]
