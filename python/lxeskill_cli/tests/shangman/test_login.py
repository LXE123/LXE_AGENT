from __future__ import annotations

import asyncio
import base64
import io
import json
import os
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor

import pytest
from PIL import Image

from services.shangman.auth import AuthClient, AuthError, Credentials, LoginToken
from services.shangman.state import AuthStore, atomic_json, read_json
from services.shangman import workflow


@pytest.fixture
def context(tmp_path, monkeypatch):
    monkeypatch.setenv("LXE_DATA_ROOT", str(tmp_path))
    monkeypatch.delenv("LXE_SHANGMAN_CONFIG_REVISION", raising=False)
    from shared import workspace
    monkeypatch.setattr(workspace, "_artifact_root", tmp_path / "artifacts")
    for key, value in zip(("TENANT_ID", "USERNAME", "PROCESSED_PASSWORD"), ("tenant-123", "operator-456", "password-789")):
        monkeypatch.setenv("LXE_SHANGMAN_" + key, value)
    credentials = Credentials.from_environment()
    return credentials, AuthStore(credentials)


def png():
    target = io.BytesIO()
    Image.new("RGB", (120, 40), "white").save(target, "PNG")
    return target.getvalue()


@pytest.mark.parametrize("captcha_code,ttl", [("Ab9X", 900), ("wr", 21600)])
def test_fresh_login_pairs_image_and_key_and_persists(context, monkeypatch, captcha_code, ttl):
    c, store = context
    calls = []
    async def request(self, method, path, **kwargs):
        calls.append((method, path, kwargs))
        if path.endswith("captcha"):
            return {"key": "actual-platform-key", "image": "data:image/png;base64," + base64.b64encode(png()).decode()}
        assert kwargs["headers"]["Captcha-Key"] == "actual-platform-key"
        assert kwargs["headers"]["Captcha-Code"] == captcha_code
        assert kwargs["params"]["password"] == c.effective_password
        assert kwargs["params"]["grant_type"] == "captcha"
        assert kwargs["headers"]["Authorization"] == "Basic " + base64.b64encode(b"saber:saber_secret").decode()
        return {"access_token": "private-token", "expires_in": ttl}
    monkeypatch.setattr(AuthClient, "_request", request)
    store.save(LoginToken("old-token", 300))
    prepared = workflow.run_action("prepare", {})
    assert prepared["success"]
    assert "actual-platform-key" not in json.dumps(prepared)
    result = workflow.run_action("submit", {"challenge_id": prepared["challenge_id"], "captcha_code": captcha_code})
    assert result["persisted"] and result["login_succeeded"]
    assert result["expires_at"] - result["logged_in_at"] == ttl
    assert len(calls) == 2
    assert store.read_token() == "private-token"
    assert not os.path.exists(prepared["image_path"])
    assert "private-token" not in json.dumps(result)
    assert store.status()["online_verified"] is False
    again = workflow.run_action("submit", {"challenge_id": prepared["challenge_id"], "captcha_code": captcha_code})
    assert again["error"]["code"] == "challenge_unavailable"
    assert len(calls) == 2


def test_timeout_consumes_challenge_without_retry(context, monkeypatch):
    _, store = context
    challenge = store.prepare("platform-key", png())
    attempts = []
    async def login(self, key, code):
        attempts.append(key)
        raise TimeoutError("upstream timed out")
    monkeypatch.setattr(AuthClient, "login", login)
    args = {"challenge_id": challenge["challenge_id"], "captcha_code": "abcd"}
    assert "upstream timed out" in workflow.run_action("submit", args)["error"]["message"]
    assert workflow.run_action("submit", args)["error"]["code"] == "challenge_unavailable"
    assert attempts == ["platform-key"]


def test_concurrent_consumers_only_one_wins(context):
    _, store = context
    challenge = store.prepare("one-key", png())
    def consume():
        try:
            return store.consume(challenge["challenge_id"])[0]
        except AuthError as exc:
            return exc.code
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: consume(), range(2)))
    assert sorted(results) == ["challenge_unavailable", "one-key"]


def test_expiry_and_credential_change(context):
    c, store = context
    challenge = store.prepare("key", png())
    path = store.root / (challenge["challenge_id"] + ".json")
    payload = read_json(path)
    payload["expires_at"] = 1
    atomic_json(path, payload)
    with pytest.raises(AuthError, match="过期"):
        store.consume(challenge["challenge_id"])
    challenge = store.prepare("key", png())
    changed = AuthStore(Credentials(c.tenant_id, c.username, "new-password"))
    with pytest.raises(AuthError, match="凭据已变更"):
        changed.consume(challenge["challenge_id"])
    store.save(LoginToken("private", 300))
    assert changed.status()["status"] == "missing"


def test_state_cross_process_and_account_isolation(context):
    c, store = context
    store.save(LoginToken("cross-process-token", 600))
    result = subprocess.run([sys.executable, "-c", "from services.shangman.auth import Credentials; from services.shangman.state import AuthStore; assert AuthStore(Credentials.from_environment()).read_token() == 'cross-process-token'"], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    other = AuthStore(Credentials(c.tenant_id, "different-account", c.password))
    assert other.status()["status"] == "missing"
    store.invalidate("older-token")
    assert store.read_token() == "cross-process-token"
    store.invalidate("cross-process-token")
    with pytest.raises(AuthError, match="缺失或过期"):
        store.read_token()


def test_clear_invalidates_pending_and_inflight_login(context):
    _, store = context
    challenge = store.prepare("key", png())
    _, epoch = store.consume(challenge["challenge_id"])
    another = store.prepare("another", png())
    store.save(LoginToken("old", 300))
    store.clear()
    with pytest.raises(AuthError, match="已清除"):
        store.save(LoginToken("late", 300), epoch=epoch)
    assert store.status()["status"] == "missing"
    assert not os.path.exists(another["image_path"])


def test_desktop_revision_invalidates_old_process(context, monkeypatch):
    c, store = context
    monkeypatch.setenv("LXE_SHANGMAN_CONFIG_REVISION", "version-1")
    configured = AuthStore(Credentials.from_environment())
    from shared.repository import state_root
    settings = state_root() / "config" / "settings.json"
    atomic_json(settings, {"integrations": {"shangman": {"revision": "version-1"}}})
    challenge = configured.prepare("key", png())
    configured.save(LoginToken("private", 300))
    atomic_json(settings, {"integrations": {"shangman": {"revision": "version-2"}}})
    with pytest.raises(AuthError, match="配置已变更"):
        configured.read_token()
    with pytest.raises(AuthError, match="配置已变更"):
        configured.consume(challenge["challenge_id"])
    with pytest.raises(AuthError, match="配置已变更"):
        configured.save(LoginToken("late", 300))


def test_login_requires_credentials(context, monkeypatch):
    async def captcha(self):
        return "actual-key", png()
    monkeypatch.setattr(AuthClient, "captcha", captcha)
    assert workflow.run_action("prepare", {})["success"]
    assert workflow.run_action("status", {})["success"]
    monkeypatch.delenv("LXE_SHANGMAN_USERNAME")
    result = workflow.run_action("prepare", {})
    assert result["error"]["code"] == "credentials_required"
    assert "LXE_SHANGMAN_USERNAME" in result["error"]["message"]


def test_login_success_save_failure_is_reported_separately(context, monkeypatch):
    _, store = context
    challenge = store.prepare("key", png())
    async def login(*args):
        return LoginToken("private-token", 300)
    def fail(*args, **kwargs):
        raise OSError("Disk full private-token")
    monkeypatch.setattr(AuthClient, "login", login)
    monkeypatch.setattr(AuthStore, "save", fail)
    result = workflow.run_action("submit", {"challenge_id": challenge["challenge_id"], "captcha_code": "AbCD"})
    assert not result["success"] and result["login_succeeded"] and not result["persisted"]
    assert "Disk full" in result["error"]["message"]
    assert "private-token" not in json.dumps(result)


@pytest.mark.parametrize("ttl", [None, "wrong", -2, 0, float("inf"), float("nan")])
def test_invalid_ttl_falls_back(context, monkeypatch, ttl):
    c, _ = context
    async def request(*args, **kwargs):
        return {"access_token": "private", "expires_in": ttl}
    monkeypatch.setattr(AuthClient, "_request", request)
    assert asyncio.run(AuthClient(c).login("key", "code")).ttl == 300


def test_real_error_is_preserved_redacted_and_explicitly_truncated(context, monkeypatch):
    c, _ = context
    async def request(*args, **kwargs):
        return {"error_description": "bad captcha " + c.password + " platform-key ABCD", "access_token": "", "refresh_token": "secret-refresh"}
    monkeypatch.setattr(AuthClient, "_request", request)
    with pytest.raises(AuthError) as error:
        asyncio.run(AuthClient(c).login("platform-key", "ABCD"))
    text = str(error.value)
    assert "bad captcha" in text
    for secret in [c.password, "platform-key", "ABCD", "secret-refresh"]:
        assert secret not in text
    assert c.diagnostic("x" * 3000).endswith("[truncated]")


def test_invalid_image_and_path_are_rejected(context, monkeypatch):
    c, store = context
    async def request(*args, **kwargs):
        return {"key": "platform-key", "image": "invalid-base64!"}
    monkeypatch.setattr(AuthClient, "_request", request)
    with pytest.raises(AuthError) as error:
        asyncio.run(AuthClient(c).captcha())
    assert error.value.code == "invalid_image"
    with pytest.raises(AuthError):
        store.consume("../../state")


def test_atomic_write_failure_preserves_previous_token(context, monkeypatch):
    _, store = context
    store.save(LoginToken("previous", 300))
    def fail(*args):
        raise OSError("replace failed")
    monkeypatch.setattr(os, "replace", fail)
    with pytest.raises(OSError, match="replace failed"):
        store.save(LoginToken("new", 300))
    assert store.read_token() == "previous"
    assert set(p.name for p in store.root.iterdir()) == {"state.json", "auth.lock"}
    if os.name != "nt":
        assert store.state_path.stat().st_mode & 0o777 == 0o600


def test_expired_auth_requires_login(context):
    _, store = context
    store.save(LoginToken("expired", -1))
    assert store.status()["status"] == "expired"
    with pytest.raises(AuthError):
        store.read_token()


def test_cli_contract_exposes_image_only_as_model_input(context, monkeypatch, capsys):
    from lxeskill import cli
    c, _ = context
    async def captcha(self):
        return "actual-key", png()
    monkeypatch.setattr(AuthClient, "captcha", captcha)
    assert cli.main(["shangman", "login", "prepare"]) == 0
    record = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert record["ok"] and record["files"] == []
    assert os.path.isfile(record["data"]["image_path"])
    assert "actual-key" not in json.dumps(record)
    args = ["shangman", "login", "submit", "--challenge-id", record["data"]["challenge_id"], "--captcha-code", "ABCD"]
    async def login(self, key, code):
        raise AuthError("login_failed", "platform says captcha expired")
    monkeypatch.setattr(AuthClient, "login", login)
    assert cli.main(args) != 0
    failed = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert not failed["ok"]
    assert "recovery" not in failed
    assert "platform says captcha expired" in failed["error"]["message"]
    assert failed["data"]["error"]["code"] == "login_failed"


@pytest.mark.parametrize("status,body,expected", [
    (400, '{"code":400,"success":false,"msg":"验证码不正确"}', "HTTP 400"),
    (401, '{"error_description":"actual denial","access_token":"do-not-log"}', "HTTP 401"),
    (200, 'not JSON: upstream failure', 'upstream failure'),
    (200, '[1,2,3]', 'expected object'),
    (302, 'redirect response', 'HTTP 302'),
])
def test_http_boundary_preserves_response_and_never_retries(context, monkeypatch, status, body, expected):
    import threading
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    from services.shangman import auth
    calls = []
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            calls.append(self.path)
            self.send_response(status)
            self.send_header("Location", "/must-not-follow")
            self.end_headers()
            self.wfile.write(body.encode())
        def log_message(self, *args):
            pass
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    monkeypatch.setattr(auth, "BASE_URL", f"http://127.0.0.1:{server.server_port}")
    try:
        with pytest.raises(AuthError) as error:
            asyncio.run(AuthClient(context[0])._request("GET", "/api/blade-auth/oauth/token"))
        assert expected in str(error.value)
        assert "do-not-log" not in str(error.value)
        assert calls == ["/api/blade-auth/oauth/token"]
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def test_client_identity_needs_no_account_configuration(context):
    c = Credentials.from_environment()
    assert c.basic_auth == "Basic " + base64.b64encode(b"saber:saber_secret").decode()
    assert c.fingerprint == context[0].fingerprint
