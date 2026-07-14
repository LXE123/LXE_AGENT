from __future__ import annotations


from services.agent_cli.mabang import download_fba_delivery_csv as cli
from services.mabang.amazon.fba.batch_delivery import BatchDeliveryCsvResult


def test_missing_delivery_no_returns_failure_json(monkeypatch, capsys):

    payload = cli.run({})
    assert payload == {
        "success": False,
        "delivery_no": "",
        "exception": "delivery_no 不能为空",
    }


def test_invalid_delivery_no_returns_failure_json(monkeypatch, capsys):

    payload = cli.run({"delivery_no": 'FBA123'})
    assert payload == {
        "success": False,
        "delivery_no": "FBA123",
        "exception": "delivery_no 格式无效: FBA123",
    }


def test_success_returns_downloaded_csv_path(monkeypatch, capsys):

    async def fake_download(delivery_no: str, *, timeout_sec: float, poll_interval_sec: float):
        assert delivery_no == "SP260508022"
        assert timeout_sec == 180
        assert poll_interval_sec == 10
        return BatchDeliveryCsvResult(
            delivery_no="SP260508022",
            delivery_id=147674,
            task_id=370502,
            file_hash="hash-1",
            file_name="delivery.csv",
            csv_path="artifacts/mabang_fba_delivery/SP260508022_370502.csv",
        )

    monkeypatch.setattr(cli, "download_fba_delivery_csv", fake_download)

    payload = cli.run({"delivery_no": 'sp260508022'})
    assert payload == {
        "success": True,
        "delivery_no": "SP260508022",
        "delivery_id": 147674,
        "task_id": 370502,
        "file_hash": "hash-1",
        "file_name": "delivery.csv",
        "csv_path": "artifacts/mabang_fba_delivery/SP260508022_370502.csv",
        "source": "mabang_fba_delivery",
    }


def test_success_preserves_explicit_poll_interval(monkeypatch, capsys):

    async def fake_download(delivery_no: str, *, timeout_sec: float, poll_interval_sec: float):
        assert delivery_no == "SP260508022"
        assert timeout_sec == 180
        assert poll_interval_sec == 15
        return BatchDeliveryCsvResult(
            delivery_no="SP260508022",
            delivery_id=147674,
            task_id=370502,
            file_hash="hash-1",
            file_name="delivery.csv",
            csv_path="artifacts/mabang_fba_delivery/SP260508022_370502.csv",
        )

    monkeypatch.setattr(cli, "download_fba_delivery_csv", fake_download)

    payload = cli.run({"delivery_no": 'sp260508022', "poll_interval_sec": '15'})
    assert payload["success"] is True


def test_download_error_returns_failure_json(monkeypatch, capsys):

    async def fake_download(delivery_no: str, *, timeout_sec: float, poll_interval_sec: float):
        raise RuntimeError(f"download failed for {delivery_no}")

    monkeypatch.setattr(cli, "download_fba_delivery_csv", fake_download)

    payload = cli.run({"delivery_no": 'SP260508022'})
    assert payload == {
        "success": False,
        "delivery_no": "SP260508022",
        "exception": "download failed for SP260508022",
    }
