from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import os
from pathlib import Path
import subprocess
import sys

import pytest

from services.yacang.auth_state import YacangAuthState
from services.yacang.contracts import Credentials
from services.yacang.errors import YacangError
from shared.workspace import activate_project_workspace


@pytest.fixture
def env(tmp_path, monkeypatch):
    with monkeypatch.context() as environment:
        environment.setenv('LXE_DATA_ROOT', str(tmp_path / 'state'))
        environment.setenv('LXE_WORKSPACE_ROOT', str(tmp_path / 'workspace'))
        environment.setenv('LXE_YACANG_MOBILE', 'test-mobile')
        environment.setenv('LXE_YACANG_PASSWORD', 'test-password')
        activate_project_workspace()
        yield
    activate_project_workspace()


def test_session_is_private_persistent_and_clearable_across_processes(env):
    auth = YacangAuthState(Credentials.from_environment())
    auth.save_session('private-token')
    assert auth.session() == 'private-token'
    script = "from services.yacang.auth_state import YacangAuthState; from services.yacang.contracts import Credentials; assert YacangAuthState(Credentials.from_environment()).session() == 'private-token'"
    child = subprocess.run([sys.executable, '-c', script], capture_output=True, text=True)
    assert child.returncode == 0, child.stderr
    if os.name != 'nt':
        assert auth.session_path.stat().st_mode & 0o777 == 0o600
    old = YacangAuthState(Credentials('test-mobile', 'old-password'))
    assert old.status()['status'] == 'missing'
    assert auth.session() == 'private-token'
    challenge = auth.prepare('private-key', b'test-image')
    auth.clear()
    assert auth.status()['status'] == 'missing'
    assert not Path(challenge['image_path']).exists()
    with pytest.raises(YacangError) as caught:
        auth.consume(challenge['challenge_id'])
    assert caught.value.code == 'challenge_unavailable'


def test_failed_publication_preserves_destination_and_cleans_temporary_files(env):
    auth = YacangAuthState(Credentials.from_environment())
    auth.save_session('old-token')
    auth.session_path.unlink()
    auth.session_path.mkdir()
    before = set(auth.root.iterdir())
    with pytest.raises(OSError):
        auth.save_session('new-token')
    assert auth.session_path.is_dir()
    assert set(auth.root.iterdir()) == before


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
