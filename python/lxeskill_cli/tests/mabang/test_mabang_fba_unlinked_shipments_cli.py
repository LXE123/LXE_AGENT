from __future__ import annotations

import asyncio
import json
import logging
from unittest.mock import Mock

import pytest

from services.commands.mabang import download_store_unlinked_shipments as cli
from services.mabang.amazon.fba.unlinked_shipments import (
    StoreUnlinkedShipmentDownloadResult,
    UnlinkedShipmentSnapshotResult,
    UnlinkedShipmentStatusResult,
)
from services.mabang.amazon.fba import unlinked_shipments as ship
from services.mabang.amazon.fba.batch_delivery import (
    BatchDeliveryApiError, BatchDeliveryDownloadInfo, BatchDeliveryTask, BatchDeliveryTimeoutError,
)


@pytest.fixture
def status_failure(monkeypatch, tmp_path):
    def install(status_name, stage, error):
        calls = []
        current = {"status": ""}

        async def step(name, result):
            calls.append((current["status"], name))
            if current["status"] == status_name and name == stage:
                raise error
            return result

        async def resolve(name):
            return ship.ShopOption(100, name, {})

        async def total(spec, store_id):
            current["status"] = spec.status_name
            return await step("查询数量", 1)

        async def create(spec, store_id, **kwargs):
            return await step("创建导出任务", 1001)

        async def wait(task_id, **kwargs):
            return await step("轮询导出任务", BatchDeliveryTask(task_id, "fixture-hash", "raw.csv", 2, "完成", {}))

        async def address(task_id, file_hash):
            return await step("获取下载地址", BatchDeliveryDownloadInfo(task_id, file_hash, "raw.csv", "https://example.test/raw.csv", {}))

        async def download(url, **kwargs):
            path = await step("下载文件", tmp_path / f"{kwargs['status_name']}.csv")
            path.write_text("offline fixture", encoding="utf-8")
            return path

        for name, replacement in (
            ("resolve_shop_option", resolve), ("fetch_status_total", total),
            ("create_unlinked_export_task", create), ("wait_for_delivery_task", wait),
            ("request_download_info", address), ("download_raw_file_from_url", download),
        ):
            monkeypatch.setattr(ship, name, replacement)
        snapshot = Mock(side_effect=AssertionError("任一状态失败后不得生成快照"))
        monkeypatch.setattr(cli, "build_store_unlinked_shipments_snapshot", snapshot)
        return calls, snapshot
    return install


def test_status_stage_failure_preserves_exception_and_reaches_redacted_terminal(
    status_failure, monkeypatch, tmp_path, capsys,
):
    from lxeskill import cli as lxeskill

    status, stage = "WMS待配货", "下载文件"
    message = "synthetic failure: searchToken=synthetic-search-secret Cookie=synthetic-cookie Authorization=Bearer synthetic-bearer"
    error = (BatchDeliveryTimeoutError if stage == "轮询导出任务" else BatchDeliveryApiError)(message)
    calls, snapshot = status_failure(status, stage, error)
    with pytest.raises(type(error)) as caught:
        asyncio.run(ship.download_store_unlinked_shipments("Amazon-Test", output_dir=tmp_path))
    assert caught.value is error and str(error) == message
    assert any(status in note and stage in note for note in error.__notes__)
    calls.clear()
    error.__notes__.clear()
    monkeypatch.setenv("LXESKILL_SKILL_SCOPE", "mabang-store-unlinked-shipments-export")
    monkeypatch.setenv("LXE_DATA_ROOT", str(tmp_path / "state"))
    assert lxeskill.main([
        "mabang", "store", "unlinked-shipments", "export", "--store-name", "Amazon-Test",
    ]) == lxeskill.EXIT_BUSINESS
    terminal = json.loads(capsys.readouterr().out.strip())
    assert terminal["ok"] is False and terminal["files"] == []
    diagnostic = terminal["error"]["message"]
    assert status in diagnostic and stage in diagnostic and "synthetic failure" in diagnostic
    assert terminal["data"]["exception"] == diagnostic
    for secret in ("synthetic-search-secret", "synthetic-cookie", "synthetic-bearer"):
        assert secret not in json.dumps(terminal)
    assert "[REDACTED]" in diagnostic
    expected_statuses = [spec.status_name for spec in ship.UNLINKED_SHIPMENT_STATUS_SPECS]
    assert [name for name, action in calls if action == "查询数量"] == expected_statuses[:expected_statuses.index(status) + 1]
    assert calls[-1] == (status, stage)
    assert calls.count((status, stage)) == 1
    snapshot.assert_not_called()


def test_success_returns_status_results_and_snapshot(monkeypatch, capsys, caplog) -> None:
    caplog.set_level(logging.INFO, logger="services.commands.mabang.download_store_unlinked_shipments")

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

    def fake_build_store_unlinked_shipments_snapshot(raw_file_paths, *, store_name=None, output_dir=None, query_result=None):
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

    payload = cli.run({"store_name": "Amazon-Test-US"})
    assert "[UnlinkedShipments] 开始生成 snapshot: raw_file_count=1" in caplog.text
    assert "[UnlinkedShipments] 生成 snapshot 完成: artifacts/mabang_fba_unlinked_shipments_snapshots/snapshot.xlsx" in caplog.text
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
            "confirmed_empty": False,
        },
    }


def test_success_preserves_explicit_cli_options(monkeypatch, capsys, tmp_path, caplog) -> None:
    caplog.set_level(logging.INFO, logger="services.commands.mabang.download_store_unlinked_shipments")

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
            status_results=[UnlinkedShipmentStatusResult(status_name=name, total=0) for name in ("WMS待配货", "WMS待装箱", "待关联货件")],
        )

    monkeypatch.setattr(cli, "download_store_unlinked_shipments", fake_download)

    monkeypatch.setenv("MABANG_FBA_UNLINKED_SHIPMENTS_SNAPSHOT_DIR", str(tmp_path / "snapshots"))
    payload = cli.run({"store_name": "Amazon-Test-US", "timeout_seconds": "60", "poll_interval_seconds": "15", "output_dir": str(tmp_path)})
    assert payload["success"] is True
    assert payload["snapshot"]["confirmed_empty"] is True
    assert payload["snapshot"]["total_unlinked_quantity"] == 0
    assert "snapshot_skipped_reason" not in payload


def test_success_builds_snapshot_from_multiple_current_raw_files(monkeypatch, capsys) -> None:

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

    def fake_build_store_unlinked_shipments_snapshot(raw_file_paths, *, store_name=None, output_dir=None, query_result=None):
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

    payload = cli.run({"store_name": "Amazon-Test-US"})
    assert payload["snapshot"]["snapshot_xlsx_path"] == "artifacts/mabang_fba_unlinked_shipments_snapshots/snapshot.xlsx"
    assert payload["snapshot"]["raw_file_count"] == 2


def test_snapshot_error_returns_failure_json_with_download_result(monkeypatch, capsys, caplog) -> None:
    caplog.set_level(logging.INFO, logger="services.commands.mabang.download_store_unlinked_shipments")

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

    payload = cli.run({"store_name": "Amazon-Test-US"})
    assert "[UnlinkedShipments] 开始生成 snapshot: raw_file_count=1" in caplog.text
    assert "[UnlinkedShipments] 生成 snapshot 失败: snapshot failed" in caplog.text
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
