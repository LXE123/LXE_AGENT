import io
import json
import os
import subprocess
import sys
import urllib.error

import pytest

from services import feishu_stock_sync as sync
from services.commands.feishu import stock_sync as command


def test_missing_configuration_is_reported_without_values(monkeypatch, tmp_path):
    for field in ("APP_ID", "APP_SECRET", "FOLDER_TOKEN"):
        monkeypatch.setattr(sync, field, "")
    result = command.run({"destination": str(tmp_path)})
    assert result["success"] is False
    assert "STOCK_SYNC_FEISHU_APP_SECRET" in result["log"]


def test_partial_run_reports_only_files_processed_this_run(monkeypatch, tmp_path):
    names = list(sync.MAPPING)
    monkeypatch.setattr(sync, "APP_SECRET", "sensitive-value")

    def fake_sync(destination, workers):
        assert destination == str(tmp_path)
        assert workers == 1
        print(f"处理完成 {names[0]}: ok")
        print("下载失败 sensitive-value")
        return False

    monkeypatch.setattr(sync, "sync_stock_lists", fake_sync)
    result = command.run({"destination": str(tmp_path)})
    assert result["success"] is False
    assert result["files"] == [str(tmp_path / names[0])]
    assert "sensitive-value" not in result["log"]


def test_requires_destination_and_valid_worker_count():
    assert command.run({})["success"] is False
    assert command.run({"destination": "x", "workers": 0})["success"] is False


def test_failed_download_preserves_previous_file(monkeypatch, tmp_path):
    name = "测试.xlsx"
    old = tmp_path / name
    old.write_bytes(b"previous")
    monkeypatch.setattr(sync, "MAPPING", {name: "测试"})
    monkeypatch.setattr(sync, "get_cloud_files", lambda: {name: "token"})
    monkeypatch.setattr(sync, "download_one", lambda *args: None)
    assert sync.sync_stock_lists(str(tmp_path), workers=1) is False
    assert old.read_bytes() == b"previous"


def test_duplicate_target_names_stop_before_download(monkeypatch, tmp_path, capsys):
    name = "测试.xlsx"
    old = tmp_path / name
    old.write_bytes(b"previous")
    monkeypatch.setattr(sync, "MAPPING", {name: "测试"})
    for field in ("APP_ID", "APP_SECRET", "FOLDER_TOKEN"):
        monkeypatch.setattr(sync, field, "configured")
    pages = iter([
        {"data": {"files": [{"name": name, "token": "one"}], "has_more": True, "next_page_token": "next"}},
        {"data": {"files": [{"name": name, "token": "two"}], "has_more": False}},
    ])
    monkeypatch.setattr(sync, "_authorized_json", lambda *args: next(pages))
    assert sync.sync_stock_lists(str(tmp_path), workers=1) is False
    assert "重复的目标文件名" in capsys.readouterr().out
    assert old.read_bytes() == b"previous"


def test_lock_prevents_overlapping_sync(monkeypatch, tmp_path):
    def unexpected_network():
        raise AssertionError("network must not be called while locked")

    monkeypatch.setattr(sync, "get_cloud_files", unexpected_network)
    with sync._run_lock(str(tmp_path)):
        with pytest.raises((RuntimeError, OSError)):
            sync.sync_stock_lists(str(tmp_path), workers=1)


def test_auth_error_does_not_print_returned_token(monkeypatch):
    monkeypatch.setattr(sync, "_TOKEN", None)
    monkeypatch.setattr(sync, "_json_request", lambda *args, **kwargs: {
        "code": 123, "msg": "authentication failed", "tenant_access_token": "secret-token",
    })
    with pytest.raises(RuntimeError) as error:
        sync.get_token()
    assert "authentication failed" in str(error.value)
    assert "secret-token" not in str(error.value)


def test_stock_credentials_are_independent_from_feishu_gateway():
    environment = os.environ.copy()
    environment.update({
        "FEISHU_APP_ID": "", "FEISHU_APP_SECRET": "",
        "STOCK_SYNC_FEISHU_APP_ID": "stock-app",
        "STOCK_SYNC_FEISHU_APP_SECRET": "stock-secret",
        "STOCK_SYNC_FEISHU_FOLDER_TOKEN": "stock-folder",
    })
    script = (
        "from services import feishu_stock_sync as s; "
        "assert (s.APP_ID, s.APP_SECRET, s.FOLDER_TOKEN) == "
        "('stock-app', 'stock-secret', 'stock-folder')"
    )
    subprocess.run([sys.executable, "-c", script], env=environment, check=True, capture_output=True)


def test_file_listing_retries_transient_network_errors(monkeypatch):
    calls = []
    backoffs = []

    def urlopen(request, timeout):
        calls.append(request)
        if len(calls) < 3:
            raise urllib.error.URLError("temporary disconnect")
        return io.BytesIO(b'{"code":0,"data":{}}')

    monkeypatch.setattr(sync, "get_token", lambda **kwargs: "token")
    monkeypatch.setattr(sync.urllib.request, "urlopen", urlopen)
    monkeypatch.setattr(sync, "_backoff", backoffs.append)
    assert sync._authorized_json("/drive/v1/files")["code"] == 0
    assert len(calls) == 3
    assert backoffs == [1, 2]


def test_file_listing_refreshes_expired_token(monkeypatch):
    calls = []
    refreshes = []

    def token(force=False, stale_token=None):
        refreshes.append((force, stale_token))
        return "new-token" if force else "old-token"

    def request(url, **kwargs):
        calls.append(kwargs["headers"]["Authorization"])
        return {"code": 99991661} if len(calls) == 1 else {"code": 0}

    monkeypatch.setattr(sync, "get_token", token)
    monkeypatch.setattr(sync, "_json_request", request)
    assert sync._authorized_json("/drive/v1/files")["code"] == 0
    assert calls == ["Bearer old-token", "Bearer new-token"]
    assert refreshes == [(False, None), (True, "old-token")]


@pytest.mark.parametrize("status", [429, 503])
def test_token_request_retries_transient_http_errors(monkeypatch, status):
    calls = []
    backoffs = []

    def urlopen(request, timeout):
        calls.append(request)
        if len(calls) == 1:
            raise urllib.error.HTTPError(request.full_url, status, "temporary", None, None)
        return io.BytesIO(b'{"code":0,"tenant_access_token":"new-token"}')

    monkeypatch.setattr(sync, "_TOKEN", None)
    monkeypatch.setattr(sync.urllib.request, "urlopen", urlopen)
    monkeypatch.setattr(sync, "_backoff", backoffs.append)
    assert sync.get_token() == "new-token"
    assert len(calls) == 2
    assert backoffs == [1]


def test_auth_rejection_is_not_retried(monkeypatch):
    calls = []

    def urlopen(request, timeout):
        calls.append(request)
        raise urllib.error.HTTPError(request.full_url, 403, "denied", None, None)

    monkeypatch.setattr(sync.urllib.request, "urlopen", urlopen)
    with pytest.raises(urllib.error.HTTPError):
        sync._json_request("https://example.invalid", attempts=3)
    assert len(calls) == 1


def test_request_failure_does_not_log_query_secrets(monkeypatch):
    def urlopen(request, timeout):
        raise urllib.error.URLError("temporary disconnect")

    monkeypatch.setattr(sync.urllib.request, "urlopen", urlopen)
    with pytest.raises(RuntimeError) as error:
        sync._json_request("https://example.invalid/files?folder_token=private", attempts=1)
    assert "private" not in str(error.value)
    assert "temporary disconnect" in str(error.value)


def test_cli_returns_processed_paths_in_data(monkeypatch, tmp_path, capsys):
    from lxeskill import cli

    name = "测试.xlsx"
    monkeypatch.setattr(sync, "MAPPING", {name: "测试"})

    def fake_sync(destination, workers):
        print(f"处理完成 {name}: ok")
        return True

    monkeypatch.setattr(sync, "sync_stock_lists", fake_sync)
    assert cli.main(["feishu", "stock-lists", "sync", "--destination", str(tmp_path)]) == 0
    result = json.loads(capsys.readouterr().out)
    assert result["ok"] is True
    assert result["data"]["files"] == [str(tmp_path / name)]
