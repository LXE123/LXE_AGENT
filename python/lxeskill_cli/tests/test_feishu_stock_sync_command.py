from services import feishu_stock_sync as sync
from services.commands.feishu import stock_sync as command
import pytest


def test_missing_configuration_is_reported_without_values(monkeypatch, tmp_path):
    for field in ("APP_ID", "APP_SECRET", "FOLDER_TOKEN"):
        monkeypatch.setattr(sync, field, "")
    result = command.run({"destination": str(tmp_path)})
    assert result["success"] is False
    assert "FEISHU_APP_SECRET" in result["log"]


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
