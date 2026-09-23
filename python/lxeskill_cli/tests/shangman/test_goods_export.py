from __future__ import annotations

import io
import json
from pathlib import Path
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from zipfile import ZipFile

import pytest
from openpyxl import Workbook

from services.shangman import goods_export as exports
from services.shangman.auth import AuthError, Credentials, LoginToken
from services.shangman.state import AuthStore, atomic_json, read_json


def workbook_bytes(*, empty=False, bilingual=False, bad_dimensions=False, bad_headers=False):
    wb = Workbook()
    sheet = wb.active
    headers = sorted(exports.REQUIRED_HEADERS)
    if bad_headers:
        headers.remove("SKU")
    translations = {"SKU": "商品编码", "商品名": "商品名称"}
    sheet.append([f"English\n({translations.get(h, h)})"
                  if bilingual else h for h in headers])
    if not empty:
        sheet.append(["source data"] * len(headers))
    output = io.BytesIO()
    wb.save(output)
    wb.close()
    if not bad_dimensions:
        return output.getvalue()
    rewritten = io.BytesIO()
    with ZipFile(output) as source, ZipFile(rewritten, "w") as target:
        for item in source.infolist():
            content = source.read(item.filename)
            if item.filename == "xl/worksheets/sheet1.xml":
                content = re.sub(rb'<dimension ref="[^"]+"', b'<dimension ref="A1"', content)
            target.writestr(item, content)
    return rewritten.getvalue()


@pytest.fixture
def context(tmp_path, monkeypatch):
    from shared import workspace
    monkeypatch.setenv("LXE_DATA_ROOT", str(tmp_path))
    monkeypatch.delenv("LXE_SHANGMAN_CONFIG_REVISION", raising=False)
    for key, value in zip(("TENANT_ID", "USERNAME", "PROCESSED_PASSWORD"), ("tenant-123", "operator-456", "password-789")):
        monkeypatch.setenv("LXE_SHANGMAN_" + key, value)
    monkeypatch.setattr(workspace, "_artifact_root", tmp_path / "artifacts")
    credentials = Credentials.from_environment()
    store = AuthStore(credentials)
    store.save(LoginToken("private-token", 300))
    return credentials, store, tmp_path


@pytest.fixture
def server(context, monkeypatch):
    state = {"post_status": 200, "get_status": 200, "xlsx": workbook_bytes(), "calls": []}

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            state["calls"].append(("POST", self.path, dict(self.headers)))
            if state.get("before_response"):
                state["before_response"]()
            self.send_response(state["post_status"])
            self.send_header("Location", "/must-not-follow")
            self.end_headers()
            body = state.get("payload", {"code": 200, "success": True, "data": state["url"]})
            self.wfile.write((body if isinstance(body, str) else json.dumps(body)).encode())

        def do_GET(self):
            state["calls"].append(("GET", self.path, dict(self.headers)))
            self.send_response(state["get_status"])
            self.send_header("Location", "/must-not-follow")
            self.send_header("Set-Cookie", "ERP_SESSION=do-not-reuse")
            self.end_headers()
            self.wfile.write(state["xlsx"])

        def log_message(self, *args):
            pass

    http = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=http.serve_forever, daemon=True)
    thread.start()
    state["url"] = f"http://localhost:{http.server_port}/goods.xlsx?signature=signed-private-value"
    monkeypatch.setattr(exports, "BASE_URL", f"http://127.0.0.1:{http.server_port}")
    # Only the approved-URL boundary is bypassed for this loopback integration.
    # Its production behavior is independently tested below.
    monkeypatch.setattr(exports.GoodsExporter, "_validate_download_url", lambda self, url: url)
    try:
        yield state
    finally:
        http.shutdown()
        http.server_close()
        thread.join()


@pytest.mark.parametrize("options", [{}, {"bilingual": True}, {"bad_dimensions": True}, {"empty": True}])
def test_real_http_chain_preserves_source_bytes_and_does_not_leak_auth(context, server, options):
    server["xlsx"] = workbook_bytes(**options)
    result = exports.run({})
    assert result["success"], result
    path = Path(result["artifact_path"])
    assert path.read_bytes() == server["xlsx"]
    assert path.name.startswith("上马-商品-")
    assert path.parent.parent == context[2] / "artifacts/shangman/indonesia"
    assert result["row_count"] == (0 if options.get("empty") else 1)
    assert bool(result["notice"]) == bool(options.get("empty"))
    assert len(server["calls"]) == 2
    method, endpoint, headers = server["calls"][0]
    assert (method, endpoint) == ("POST", exports.EXPORT_PATH)
    assert headers["Blade-Auth"] == "bearer private-token"
    assert headers["Authorization"] == context[0].basic_auth
    assert headers["Tenant-Id"] == context[0].tenant_id
    download_headers = server["calls"][1][2]
    assert not {"Authorization", "Blade-Auth", "Tenant-Id", "Cookie"} & download_headers.keys()
    assert "private-token" not in json.dumps(result)
    assert "signed-private-value" not in json.dumps(result)


def test_sequential_invocations_use_new_loops_and_unique_output_directories(context, server):
    results = [exports.run({}) for _ in range(3)]
    assert all(r["success"] for r in results), results
    assert len({r["artifact_path"] for r in results}) == 3
    assert len(server["calls"]) == 6
    server["get_status"] = 500
    assert exports.run({})["error"]["code"] == "download_failed"
    server["get_status"] = 200
    assert exports.run({})["success"]


@pytest.mark.parametrize("state", ["missing", "expired", "changed_credentials"])
def test_unusable_login_makes_no_http_request(context, server, state, monkeypatch):
    _, store, _ = context
    if state == "missing":
        store.clear()
    elif state == "expired":
        payload = read_json(store.state_path)
        payload["expires_at"] = time.time() - 1
        atomic_json(store.state_path, payload)
    else:
        monkeypatch.setenv("LXE_SHANGMAN_PROCESSED_PASSWORD", "changed-password")
    result = exports.run({})
    assert not result["success"]
    assert result["error"]["code"] == "login_required"
    assert not server["calls"]


@pytest.mark.parametrize("http_status,payload,invalidates", [
    (401, {"msg": "actual token rejection"}, True),
    (200, {"code": 401, "msg": "actual token rejection"}, True),
    (403, {"msg": "permission denied"}, False),
    (429, {"msg": "rate limited"}, False),
    (500, {"msg": "server failed"}, False),
    (302, {"msg": "redirect"}, False),
    (200, {"code": 500, "success": False, "msg": "business failed"}, False),
    (200, "not-json", False),
    (200, [1, 2], False),
])
def test_export_failures_keep_diagnostics_without_retries(context, server, http_status, payload, invalidates):
    server.update(post_status=http_status, payload=payload)
    result = exports.run({})
    assert not result["success"]
    assert len(server["calls"]) == 1
    expected = payload.get("msg") if isinstance(payload, dict) else payload if isinstance(payload, str) else "[1, 2]"
    assert expected in result["error"]["message"]
    assert context[1].status()["authenticated"] is not invalidates
    if invalidates:
        assert result["error"]["code"] == "login_required"


def test_rejected_old_token_does_not_erase_concurrent_login(context, server):
    server.update(post_status=401, payload={"msg": "expired"},
                  before_response=lambda: context[1].save(LoginToken("new-token", 300)))
    assert exports.run({})["error"]["code"] == "login_required"
    assert context[1].read_token() == "new-token"


@pytest.mark.parametrize("status", [401, 403, 429, 500, 302])
def test_oss_download_failures_do_not_invalidate_erp_login(context, server, status):
    server.update(get_status=status, xlsx=b"original OSS failure")
    result = exports.run({})
    assert not result["success"]
    assert "original OSS failure" in result["error"]["message"]
    assert len(server["calls"]) == 2
    assert context[1].status()["authenticated"]
    assert not list(context[2].rglob("*.xlsx"))


@pytest.mark.parametrize("content", [b"", b"<html>login page</html>", workbook_bytes(bad_headers=True)])
def test_invalid_workbooks_are_not_published(context, server, content):
    server["xlsx"] = content
    assert exports.run({})["error"]["code"] == "invalid_workbook"
    assert not list(context[2].rglob("*.xlsx"))


@pytest.mark.parametrize("url", [
    "http://oss.erp.shangmanet.com/file.xlsx", "https://evil.test/file.xlsx",
    "https://oss.erp.shangmanet.com.evil.test/file.xlsx", "https://user:pass@erp.shangmanet.com/file",
    "https://oss.erp.shangmanet.com:8443/file", "https://oss.erp.shangmanet.com/fi\nle",
    None,
])
def test_download_host_restrictions(context, url):
    client = exports.GoodsExporter(context[0], context[1])
    with pytest.raises(AuthError, match="HTTPS"):
        client._validate_download_url(url)


@pytest.mark.parametrize("host", ["erp.shangmanet.com", "oss.erp.shangmanet.com"])
def test_approved_download_hosts(context, host):
    url = f"https://{host}/goods.xlsx?sign=secret"
    assert exports.GoodsExporter(context[0], context[1])._validate_download_url(url) == url


def test_error_diagnostics_redact_token_credentials_and_signed_query(context, server):
    server.update(post_status=500, payload={"msg": "private-token password-789 " + server["url"]})
    message = exports.run({})["error"]["message"]
    assert "HTTP 500" in message
    for secret in ("private-token", "password-789", "signed-private-value"):
        assert secret not in message


def test_network_timeout_preserves_exception_and_does_not_retry(context, monkeypatch):
    calls = []
    def timeout(*args, **kwargs):
        calls.append(1)
        raise TimeoutError("actual connection deadline")
    monkeypatch.setattr(exports.aiohttp, "ClientSession", timeout)
    result = exports.run({})
    assert "TimeoutError: actual connection deadline" in result["error"]["message"]
    assert calls == [1]
    assert context[1].status()["authenticated"]
