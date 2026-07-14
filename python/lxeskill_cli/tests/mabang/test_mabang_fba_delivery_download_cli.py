from __future__ import annotations


from services.agent_cli.mabang import download_fba_delivery_csv as cli
from services.mabang.amazon.fba.batch_delivery import BatchDeliveryCsvResult


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
