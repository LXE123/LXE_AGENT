"""Executable local fixture used by the real Electron smoke runner."""
import json
import os
import socket
import threading
import time
from email.utils import formatdate
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit, parse_qs

from browser_auth_service import service
from browser_auth_service import binding

system_executable = os.environ.get("LXE_AUTH_SMOKE_BROWSER_EXECUTABLE")
if system_executable:
    os.environ.pop(binding.HOST_URL_ENV, None)
    os.environ.pop(binding.HOST_TOKEN_ENV, None)
    binding.bind_browser(system_executable)
    def fixture_launch(playwright, *, headless):
        return playwright.chromium.launch(
            executable_path=binding.bound_executable(), headless=headless,
            args=["--host-resolver-rules=MAP *.mabangerp.com 127.0.0.1", "--no-proxy-server"],
        )
    service._launch_chromium = fixture_launch


class Fixture(BaseHTTPRequestHandler):
    login_calls = 0
    fail_login = False

    def log_message(self, *args):
        pass

    def send_page(self, body, cookies=()):
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        for name in cookies:
            self.send_header("Set-Cookie", f"{name}=fixture-{name}; Path=/; Expires={formatdate(time.time()+3600, usegmt=True)}")
        data = body.encode()
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        assert parse_qs(urlsplit(self.path).query)["mod"] == ["main.doLogin"]
        self.rfile.read(int(self.headers["Content-Length"]))
        type(self).login_calls += 1
        body = {"success": False, "errCode": "CHECK_VERIFY_CODE", "message": "fixture captcha required"} if self.fail_login else {"success": True}
        self.send_page(json.dumps(body), ("PHPSESSID", service.MABANG_MEMCACHE_COOKIE_NAME))

    def do_GET(self):
        path = urlsplit(self.path).path
        port = self.server.server_port
        if path == "/login":
            self.send_page('''<input aria-label="支持手机登陆" type="text"><input aria-label="请输入登入密码" type="password"><button id="login-but">login</button><script>document.querySelector('button').onclick=async()=>{const r=await fetch('/index.php?mod=main.doLogin',{method:'POST',body:'fixture'});const b=await r.json();if(b.success)location.href='/home';};</script>''', ("PHPSESSID",))
        elif path == "/stock":
            self.send_page(f'<iframe src="http://private-amz.mabangerp.com:{port}/inventory"></iframe>')
        elif path == "/inventory":
            self.send_page("inventory", service.PRIVATE_AMZ_REQUIRED_COOKIE_NAMES)
        elif path == "/fba":
            self.send_page(f'''<script>localStorage.setItem('freeToken','wrong-parent-token')</script><iframe src="http://amz1-private.mabangerp.com:{port}/token"></iframe>''')
        elif path == "/token":
            self.send_page("<script>setTimeout(()=>localStorage.setItem('freeToken','fixture-target-token'),200)</script>")
        elif path == "/wms":
            self.send_page("WMS fixture", ("WMSID",))
        else:
            self.send_page(f'<a href="http://wms.private.mabangerp.com:{port}/wms?mod=main.jumpToWms">WMS</a>')


server = ThreadingHTTPServer(("127.0.0.1", 0), Fixture)
threading.Thread(target=server.serve_forever, daemon=True).start()
port = server.server_port
root = f"http://private.mabangerp.com:{port}"
service.LOGIN_URL = root + "/login"
service.FBA_HOME_URL = root + "/home"
service.PRIVATE_AMZ_COOKIE_REFRESH_URL = root + "/stock"
service.FBA_LOGISTICS_TOKEN_TARGET_URL = root + "/fba"
service.FBA_LOGISTICS_TOKEN_ORIGIN = f"http://amz1-private.mabangerp.com:{port}"
service._resolve_credentials = lambda account: ("fixture-account", "fixture-password")
service.mabang_settings.MABANG_ACCOUNT = "fixture-account"
service.mabang_settings.MABANG_PASSWORD = "fixture-password"

try:
    if not system_executable:
        from browser_auth_service.host import HostContext, HostBrowserError
        context = HostContext(binding.host_connection(), headless=True)
        context.new_page().goto(root + '/home', wait_until='domcontentloaded')
        endpoint = urlsplit(context.url)
        connection = socket.create_connection((endpoint.hostname, endpoint.port))
        body = json.dumps({'operation':'element','session_id':context.session_id,'arguments':{'selector':{'css':"input[type='password']"},'action':'wait','timeout':30000}}).encode()
        connection.sendall((f'POST /v1/auth-browser HTTP/1.1\r\nHost: {endpoint.netloc}\r\nAuthorization: Bearer {context.token}\r\nContent-Length: {len(body)}\r\nConnection: close\r\n\r\n').encode() + body)
        time.sleep(0.2)
        connection.shutdown(socket.SHUT_RDWR)
        connection.close()
        deadline = time.monotonic() + 3
        while True:
            try:
                context.call('url')
            except HostBrowserError as error:
                if 'closed or expired' in str(error): break
                if 'active operation' not in str(error): raise
            if time.monotonic() >= deadline: raise AssertionError('Disconnected client left an authentication window alive')
            time.sleep(0.1)
        print(json.dumps({'check':'native client disconnect closes window', 'success':True}), flush=True)
    state = Path(os.environ["LXE_DATA_ROOT"]) / "state.json"
    service._state_file = lambda account: state
    result = service.refresh_auth()
    assert result["state_written"]
    payload = json.loads(state.read_text())
    token, header = service._require_complete_auth_material(payload)
    assert token == "fixture-target-token", token
    assert "WMSID=" in header
    assert Fixture.login_calls == 1
    assert service.read_auth()["free_token"] == token
    Fixture.fail_login = True
    try:
        service.refresh_auth()
        raise AssertionError("captcha response must fail")
    except service.BrowserAuthRefreshError as error:
        assert "fixture captcha required" in str(error), str(error)
        assert error.stage == "login"
    assert Fixture.login_calls == 2, "no automatic resubmission"
    assert not state.exists(), "no partial state after failure"
    print(json.dumps({"success": True, "checks": ["native DOM login", "initial session rejected until login", "inventory iframe cookies", "target frame token survives WMS navigation", "complete state saved", "captcha not retried", "failed refresh not saved"]}))
finally:
    server.shutdown()
    server.server_close()
