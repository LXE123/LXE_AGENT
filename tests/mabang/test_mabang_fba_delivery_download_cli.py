from __future__ import annotations

import json

from services.agent_cli.mabang import download_fba_delivery_csv as cli
from services.mabang.amazon.fba.batch_delivery import BatchDeliveryCsvResult


def _read_payload(capsys) -> dict:
    output = capsys.readouterr().out.strip().splitlines()
    assert output
    return json.loads(output[-1])


async def _noop_close_all_network_clients() -> None:
    return None


def test_missing_delivery_no_returns_failure_json(monkeypatch, capsys):
    monkeypatch.setattr(cli, "close_all_network_clients", _noop_close_all_network_clients)

    exit_code = cli.main([])

    payload = _read_payload(capsys)
    assert exit_code == 1
    assert payload == {
        "success": False,
        "delivery_no": "",
        "exception": "delivery_no 不能为空",
    }


def test_invalid_delivery_no_returns_failure_json(monkeypatch, capsys):
    monkeypatch.setattr(cli, "close_all_network_clients", _noop_close_all_network_clients)

    exit_code = cli.main(["--delivery-no", "FBA123"])

    payload = _read_payload(capsys)
    assert exit_code == 1
    assert payload == {
        "success": False,
        "delivery_no": "FBA123",
        "exception": "delivery_no 格式无效: FBA123",
    }


def test_success_returns_downloaded_csv_path(monkeypatch, capsys):
    monkeypatch.setattr(cli, "close_all_network_clients", _noop_close_all_network_clients)

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

    exit_code = cli.main(["--delivery-no", "sp260508022"])

    payload = _read_payload(capsys)
    assert exit_code == 0
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
    monkeypatch.setattr(cli, "close_all_network_clients", _noop_close_all_network_clients)

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

    exit_code = cli.main(["--delivery-no", "sp260508022", "--poll-interval-sec", "15"])

    payload = _read_payload(capsys)
    assert exit_code == 0
    assert payload["success"] is True


def test_download_error_returns_failure_json(monkeypatch, capsys):
    monkeypatch.setattr(cli, "close_all_network_clients", _noop_close_all_network_clients)

    async def fake_download(delivery_no: str, *, timeout_sec: float, poll_interval_sec: float):
        raise RuntimeError(f"download failed for {delivery_no}")

    monkeypatch.setattr(cli, "download_fba_delivery_csv", fake_download)

    exit_code = cli.main(["--delivery-no", "SP260508022"])

    payload = _read_payload(capsys)
    assert exit_code == 1
    assert payload == {
        "success": False,
        "delivery_no": "SP260508022",
        "exception": "download failed for SP260508022",
    }
