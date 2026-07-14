from __future__ import annotations

import json

from services.agent_cli.mabang import build_store_unlinked_shipments_snapshot as cli
from services.mabang.amazon.fba.unlinked_shipments import UnlinkedShipmentSnapshotResult


def _read_payload(capsys) -> dict:
    output = capsys.readouterr().out.strip().splitlines()
    assert output
    return json.loads(output[-1])


def test_missing_store_name_returns_failure_json(capsys) -> None:
    exit_code = cli.main([])

    payload = _read_payload(capsys)
    assert exit_code == 1
    assert payload == {
        "success": False,
        "store_name": "",
        "exception": "store_name 不能为空",
    }


def test_success_returns_snapshot_path(monkeypatch, capsys, tmp_path) -> None:
    raw_path = tmp_path / "raw.csv"

    def fake_build_store_unlinked_shipments_snapshot(raw_file_paths, *, store_name=None, output_dir=None):
        assert raw_file_paths == [str(raw_path)]
        assert store_name == "Amazon-Test-US"
        assert output_dir == str(tmp_path)
        return UnlinkedShipmentSnapshotResult(
            store_name="Amazon-Test-US",
            snapshot_time="202606130902",
            snapshot_xlsx_path=str(tmp_path / "snapshot.xlsx"),
            raw_file_count=1,
            detail_count=2,
            msku_count=1,
            total_unlinked_quantity=10,
        )

    monkeypatch.setattr(cli, "build_store_unlinked_shipments_snapshot", fake_build_store_unlinked_shipments_snapshot)

    exit_code = cli.main(
        [
            "--store-name",
            "Amazon-Test-US",
            "--raw-file",
            str(raw_path),
            "--output-dir",
            str(tmp_path),
        ]
    )

    payload = _read_payload(capsys)
    assert exit_code == 0
    assert payload == {
        "success": True,
        "store_name": "Amazon-Test-US",
        "snapshot_time": "202606130902",
        "snapshot_xlsx_path": str(tmp_path / "snapshot.xlsx"),
        "raw_file_count": 1,
        "detail_count": 2,
        "msku_count": 1,
        "total_unlinked_quantity": 10,
        "source": "mabang_fba_unlinked_shipments_snapshot",
    }


def test_build_error_returns_failure_json(monkeypatch, capsys) -> None:
    def fake_build_store_unlinked_shipments_snapshot(raw_file_paths, **kwargs):
        raise RuntimeError("build failed")

    monkeypatch.setattr(cli, "build_store_unlinked_shipments_snapshot", fake_build_store_unlinked_shipments_snapshot)

    exit_code = cli.main(["--store-name", "Amazon-Test-US", "--raw-file", "raw.csv"])

    payload = _read_payload(capsys)
    assert exit_code == 1
    assert payload == {
        "success": False,
        "store_name": "Amazon-Test-US",
        "exception": "build failed",
    }
