from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import os
from pathlib import Path
import subprocess
import sys

import pytest

from services.yacang import auth_state
from services.yacang.auth_state import YacangAuthState
from services.yacang.contracts import Credentials
from services.yacang.errors import YacangError


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setenv('LXE_DATA_ROOT', str(tmp_path))
    monkeypatch.setenv('LXE_YACANG_MOBILE', 'test-mobile')
    monkeypatch.setenv('LXE_YACANG_PASSWORD', 'test-password')
    from shared import workspace
    monkeypatch.setattr(workspace, '_artifact_root', tmp_path / 'artifacts')


def test_saved_session_is_available_after_atomic_publication_and_to_next_process(env, monkeypatch):
    auth = YacangAuthState(Credentials.from_environment())
    original = auth_state._restrict_permissions

    def reject_published_path(path, mode):
        if path == auth.session_path:
            raise PermissionError('unexpected permission change after publication')
        original(path, mode)

    monkeypatch.setattr(auth_state, '_restrict_permissions', reject_published_path)
    auth.save_session('private-token')
    assert auth.session() == 'private-token'
    script = "from services.yacang.auth_state import YacangAuthState; from services.yacang.contracts import Credentials; assert YacangAuthState(Credentials.from_environment()).session() == 'private-token'"
    child = subprocess.run([sys.executable, '-c', script], capture_output=True, text=True)
    assert child.returncode == 0, child.stderr
    if os.name != 'nt':
        assert auth.session_path.stat().st_mode & 0o777 == 0o600


def test_session_save_reports_replace_and_temporary_cleanup_failures(env, monkeypatch):
    auth = YacangAuthState(Credentials.from_environment())
    auth.save_session('previous-token')

    def fail_replace(*args):
        raise OSError('actual replace failure')

    original_unlink = Path.unlink

    def fail_temporary_unlink(path, *args, **kwargs):
        if path.parent == auth.root and path.name.startswith('tmp'):
            raise OSError('actual temporary cleanup failure')
        return original_unlink(path, *args, **kwargs)

    monkeypatch.setattr(auth_state.os, 'replace', fail_replace)
    monkeypatch.setattr(Path, 'unlink', fail_temporary_unlink)
    with pytest.raises(YacangError) as caught:
        auth.save_session('new-token')
    assert caught.value.code == 'auth_state_unavailable'
    assert 'actual replace failure' in str(caught.value)
    assert 'actual temporary cleanup failure' in str(caught.value)
    assert auth.session() == 'previous-token'


def test_concurrent_challenge_consumers_only_one_succeeds(env):
    auth = YacangAuthState(Credentials.from_environment())
    challenge = auth.prepare('private-key', b'test-image')

    def consume():
        try:
            return auth.consume(challenge['challenge_id'])[0]
        except YacangError as exc:
            return exc.code

    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(lambda _: consume(), range(2))) == ['challenge_unavailable', 'private-key']


def test_old_credentials_cannot_delete_new_credentials_session(env):
    old = YacangAuthState(Credentials('test-mobile', 'old-password'))
    new = YacangAuthState(Credentials('test-mobile', 'new-password'))
    new.save_session('new-token')
    assert old.status()['status'] == 'missing'
    assert new.session() == 'new-token'


def test_clear_removes_session_and_invalidates_challenge(env):
    auth = YacangAuthState(Credentials.from_environment())
    auth.save_session('private-token')
    challenge = auth.prepare('private-key', b'test-image')
    auth.clear()
    assert auth.status()['status'] == 'missing'
    assert not Path(challenge['image_path']).exists()
    with pytest.raises(YacangError) as caught:
        auth.consume(challenge['challenge_id'])
    assert caught.value.code == 'challenge_unavailable'
