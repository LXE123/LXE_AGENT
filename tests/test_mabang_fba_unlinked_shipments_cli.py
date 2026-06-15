from __future__ import annotations

import json

from services.agent_cli.mabang import download_store_unlinked_shipments as cli
from services.mabang.amazon.fba.unlinked_shipments import (
    StoreUnlinkedShipmentDownloadResult,
    UnlinkedShipmentSnapshotResult,
    UnlinkedShipmentStatusResult,
)


def _read_payload(capsys) -> dict:
    output = capsys.readouterr().out.strip().splitlines()
    assert output
    return json.loads(output[-1])


async def _noop_close_all_network_clients() -> None:
    return None


def test_missing_store_name_returns_failure_json(monkeypatch, capsys) -> None:
    monkeypatch.setattr(cli, "close_all_network_clients", _noop_close_all_network_clients)

    exit_code = cli.main([])

    payload = _read_payload(capsys)
    assert exit_code == 1
    assert payload == {
        "success": False,
        "store_name": "",
        "exception": "store_name 不能为空",
    }


def test_success_returns_status_results_and_snapshot(monkeypatch, capsys) -> None:
    monkeypatch.setattr(cli, "close_all_network_clients", _noop_close_all_network_clients)

    async def fake_download(
        store_name: str,
        *,
        timeout_sec: float,
        poll_interval_sec: float,
        output_dir: str | None,
    ) -> StoreUnlinkedShipmentDownloadResult:
        assert store_name == "Amazon-Test-US"
        assert timeout_sec == 180
        assert poll_interval_sec == 10
        assert output_dir is None
        return StoreUnlinkedShipmentDownloadResult(
            store_name=store_name,
            store_id=697476809,
            download_time="202606121730",
            status_results=[
                UnlinkedShipmentStatusResult(status_name="WMS待配货", total=0),
                UnlinkedShipmentStatusResult(
                    status_name="WMS待装箱",
                    total=3,
                    task_id=370502,
                    file_hash="hash-1",
                    file_name="delivery.csv",
                    raw_file_path="artifacts/mabang_fba_unlinked_shipments/file.csv",
                ),
            ],
        )

    monkeypatch.setattr(cli, "download_store_unlinked_shipments", fake_download)

    def fake_build_store_unlinked_shipments_snapshot(raw_file_paths, *, store_name=None, output_dir=None):
        assert raw_file_paths == ["artifacts/mabang_fba_unlinked_shipments/file.csv"]
        assert store_name == "Amazon-Test-US"
        assert output_dir is None
        return UnlinkedShipmentSnapshotResult(
            store_name="Amazon-Test-US",
            snapshot_time="202606121735",
            snapshot_xlsx_path="artifacts/mabang_fba_unlinked_shipments_snapshots/snapshot.xlsx",
            raw_file_count=1,
            detail_count=3,
            msku_count=2,
            total_unlinked_quantity=18,
        )

    monkeypatch.setattr(cli, "build_store_unlinked_shipments_snapshot", fake_build_store_unlinked_shipments_snapshot)

    exit_code = cli.main(["--store-name", "Amazon-Test-US"])

    payload = _read_payload(capsys)
    assert exit_code == 0
    assert payload == {
        "success": True,
        "store_name": "Amazon-Test-US",
        "store_id": 697476809,
        "download_time": "202606121730",
        "status_results": [
            {
                "status_name": "WMS待配货",
                "total": 0,
                "task_id": None,
                "file_hash": "",
                "file_name": "",
                "raw_file_path": "",
            },
            {
                "status_name": "WMS待装箱",
                "total": 3,
                "task_id": 370502,
                "file_hash": "hash-1",
                "file_name": "delivery.csv",
                "raw_file_path": "artifacts/mabang_fba_unlinked_shipments/file.csv",
            },
        ],
        "source": "mabang_fba_unlinked_shipments",
        "snapshot": {
            "success": True,
            "store_name": "Amazon-Test-US",
            "snapshot_time": "202606121735",
            "snapshot_xlsx_path": "artifacts/mabang_fba_unlinked_shipments_snapshots/snapshot.xlsx",
            "raw_file_count": 1,
            "detail_count": 3,
            "msku_count": 2,
            "total_unlinked_quantity": 18,
            "source": "mabang_fba_unlinked_shipments_snapshot",
        },
    }


def test_success_preserves_explicit_cli_options(monkeypatch, capsys, tmp_path) -> None:
    monkeypatch.setattr(cli, "close_all_network_clients", _noop_close_all_network_clients)

    async def fake_download(
        store_name: str,
        *,
        timeout_sec: float,
        poll_interval_sec: float,
        output_dir: str | None,
    ) -> StoreUnlinkedShipmentDownloadResult:
        assert store_name == "Amazon-Test-US"
        assert timeout_sec == 60
        assert poll_interval_sec == 15
        assert output_dir == str(tmp_path)
        return StoreUnlinkedShipmentDownloadResult(
            store_name=store_name,
            store_id=1,
            download_time="202606121730",
            status_results=[],
        )

    monkeypatch.setattr(cli, "download_store_unlinked_shipments", fake_download)

    exit_code = cli.main(
        [
            "--store-name",
            "Amazon-Test-US",
            "--timeout-sec",
            "60",
            "--poll-interval-sec",
            "15",
            "--output-dir",
            str(tmp_path),
        ]
    )

    payload = _read_payload(capsys)
    assert exit_code == 0
    assert payload["success"] is True
    assert payload["snapshot"] is None
    assert payload["snapshot_skipped_reason"] == "本次没有可生成快照的未关联货件原生文件"


def test_success_builds_snapshot_from_multiple_current_raw_files(monkeypatch, capsys) -> None:
    monkeypatch.setattr(cli, "close_all_network_clients", _noop_close_all_network_clients)

    async def fake_download(
        store_name: str,
        *,
        timeout_sec: float,
        poll_interval_sec: float,
        output_dir: str | None,
    ) -> StoreUnlinkedShipmentDownloadResult:
        return StoreUnlinkedShipmentDownloadResult(
            store_name=store_name,
            store_id=697476809,
            download_time="202606121730",
            status_results=[
                UnlinkedShipmentStatusResult(
                    status_name="WMS待配货",
                    total=2,
                    task_id=370501,
                    raw_file_path="artifacts/mabang_fba_unlinked_shipments/file-1.csv",
                ),
                UnlinkedShipmentStatusResult(status_name="WMS待装箱", total=0),
                UnlinkedShipmentStatusResult(
                    status_name="待关联货件",
                    total=4,
                    task_id=370502,
                    raw_file_path="artifacts/mabang_fba_unlinked_shipments/file-2.csv",
                ),
            ],
        )

    monkeypatch.setattr(cli, "download_store_unlinked_shipments", fake_download)

    def fake_build_store_unlinked_shipments_snapshot(raw_file_paths, *, store_name=None, output_dir=None):
        assert raw_file_paths == [
            "artifacts/mabang_fba_unlinked_shipments/file-1.csv",
            "artifacts/mabang_fba_unlinked_shipments/file-2.csv",
        ]
        assert store_name == "Amazon-Test-US"
        assert output_dir is None
        return UnlinkedShipmentSnapshotResult(
            store_name="Amazon-Test-US",
            snapshot_time="202606121735",
            snapshot_xlsx_path="artifacts/mabang_fba_unlinked_shipments_snapshots/snapshot.xlsx",
            raw_file_count=2,
            detail_count=6,
            msku_count=5,
            total_unlinked_quantity=30,
        )

    monkeypatch.setattr(cli, "build_store_unlinked_shipments_snapshot", fake_build_store_unlinked_shipments_snapshot)

    exit_code = cli.main(["--store-name", "Amazon-Test-US"])

    payload = _read_payload(capsys)
    assert exit_code == 0
    assert payload["snapshot"]["snapshot_xlsx_path"] == "artifacts/mabang_fba_unlinked_shipments_snapshots/snapshot.xlsx"
    assert payload["snapshot"]["raw_file_count"] == 2


def test_snapshot_error_returns_failure_json_with_download_result(monkeypatch, capsys) -> None:
    monkeypatch.setattr(cli, "close_all_network_clients", _noop_close_all_network_clients)

    async def fake_download(
        store_name: str,
        *,
        timeout_sec: float,
        poll_interval_sec: float,
        output_dir: str | None,
    ) -> StoreUnlinkedShipmentDownloadResult:
        return StoreUnlinkedShipmentDownloadResult(
            store_name=store_name,
            store_id=697476809,
            download_time="202606121730",
            status_results=[
                UnlinkedShipmentStatusResult(
                    status_name="WMS待装箱",
                    total=3,
                    task_id=370502,
                    raw_file_path="artifacts/mabang_fba_unlinked_shipments/file.csv",
                ),
            ],
        )

    def fake_build_store_unlinked_shipments_snapshot(raw_file_paths, **kwargs):
        raise RuntimeError("snapshot failed")

    monkeypatch.setattr(cli, "download_store_unlinked_shipments", fake_download)
    monkeypatch.setattr(cli, "build_store_unlinked_shipments_snapshot", fake_build_store_unlinked_shipments_snapshot)

    exit_code = cli.main(["--store-name", "Amazon-Test-US"])

    payload = _read_payload(capsys)
    assert exit_code == 1
    assert payload == {
        "success": False,
        "store_name": "Amazon-Test-US",
        "exception": "snapshot failed",
        "download_result": {
            "success": True,
            "store_name": "Amazon-Test-US",
            "store_id": 697476809,
            "download_time": "202606121730",
            "status_results": [
                {
                    "status_name": "WMS待装箱",
                    "total": 3,
                    "task_id": 370502,
                    "file_hash": "",
                    "file_name": "",
                    "raw_file_path": "artifacts/mabang_fba_unlinked_shipments/file.csv",
                }
            ],
            "source": "mabang_fba_unlinked_shipments",
        },
    }


def test_download_error_returns_failure_json(monkeypatch, capsys) -> None:
    monkeypatch.setattr(cli, "close_all_network_clients", _noop_close_all_network_clients)

    async def fake_download(store_name: str, **kwargs):
        raise RuntimeError(f"download failed for {store_name}")

    monkeypatch.setattr(cli, "download_store_unlinked_shipments", fake_download)

    exit_code = cli.main(["--store-name", "Amazon-Test-US"])

    payload = _read_payload(capsys)
    assert exit_code == 1
    assert payload == {
        "success": False,
        "store_name": "Amazon-Test-US",
        "exception": "download failed for Amazon-Test-US",
    }
