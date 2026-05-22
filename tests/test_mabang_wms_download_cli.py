from __future__ import annotations

import json
from pathlib import Path

import pytest

from agent_runtime.tools import fba_shipment_tools
from services.agent_cli.mabang import download_wms_consignment_excel as cli
from services.amazon.amazon_logistic.sources import consignment_excel as consignment_source
import services.mabang.amazon.fba.wms as wms_module


def _write_consignment_excel(path: Path, box_count: int) -> None:
    import pandas as pd

    rows = []
    for box_no in range(1, int(box_count) + 1):
        rows.append(
            {
                "箱子编号": box_no,
                "箱序号": box_no,
                "MSKU": f"SKU-{box_no}-A",
                "FBA商品名称": f"Product {box_no} A",
                "库存sku": f"LOCAL-{box_no}-A",
                "库存sku中文名称": f"商品 {box_no} A",
                "FNSKU": f"FNSKU-{box_no}-A",
                "装箱数量": 1,
                "长": 10,
                "宽": 20,
                "高": 30,
                "毛重": 12.5,
            }
        )
        rows.append(
            {
                "箱子编号": box_no,
                "箱序号": box_no,
                "MSKU": f"SKU-{box_no}-B",
                "FBA商品名称": f"Product {box_no} B",
                "库存sku": f"LOCAL-{box_no}-B",
                "库存sku中文名称": f"商品 {box_no} B",
                "FNSKU": f"FNSKU-{box_no}-B",
                "装箱数量": 2,
                "长": 10,
                "宽": 20,
                "高": 30,
                "毛重": 12.5,
            }
        )
    pd.DataFrame(rows).to_excel(path, sheet_name="FBA装箱任务", index=False)


def _read_excel(path: str | Path):
    import pandas as pd

    return pd.read_excel(path, sheet_name="FBA装箱任务")


def _read_payload(capsys) -> dict:
    output = capsys.readouterr().out.strip().splitlines()
    assert output
    return json.loads(output[-1])


def test_relative_wms_dirs_resolve_from_workspace_root():
    workspace_root = Path(__file__).resolve().parents[1]
    expected = workspace_root / "artifacts" / "mabang_wms_consignment"

    assert consignment_source.resolve_consignment_excel_dir() == expected
    assert consignment_source.resolve_test_file_dir() == expected
    assert wms_module._resolve_excel_dir() == expected


def test_prepare_upload_local_consignment_uses_shared_lookup(monkeypatch, tmp_path: Path):
    cache_dir = tmp_path / "artifacts" / "mabang_wms_consignment"
    excel_path = cache_dir / "SP260515001.xlsx"
    calls: list[str] = []

    def fake_find_consignment_excel(consignment_no: str) -> Path:
        calls.append(consignment_no)
        return excel_path

    monkeypatch.setattr(fba_shipment_tools, "find_consignment_excel", fake_find_consignment_excel)
    monkeypatch.setattr(fba_shipment_tools, "resolve_consignment_excel_dir", lambda: cache_dir)

    payload = fba_shipment_tools.prepare_upload_local_consignment_excel_payload("sp260515001")

    assert calls == ["SP260515001"]
    assert payload["consignment_no"] == "SP260515001"
    assert payload["excel_path"] == str(excel_path)
    assert payload["source"] == "local"


def test_prepare_upload_local_consignment_missing_uses_shared_cache_error(monkeypatch, tmp_path: Path):
    cache_dir = tmp_path / "artifacts" / "mabang_wms_consignment"
    cache_dir.mkdir(parents=True)
    monkeypatch.setattr(consignment_source, "resolve_consignment_excel_dir", lambda: cache_dir)

    with pytest.raises(RuntimeError) as exc_info:
        fba_shipment_tools.prepare_upload_local_consignment_excel_payload("SP260515001")

    message = str(exc_info.value)
    assert str(cache_dir) in message
    assert "services\\test_file" not in message
    assert "services/test_file" not in message


def test_prepare_upload_legacy_test_file_helpers_removed():
    assert not hasattr(fba_shipment_tools, "_resolve_prepare_upload_test_file_dir")
    assert not hasattr(fba_shipment_tools, "_find_prepare_upload_consignment_excel")


def test_missing_ship_no_returns_failure_json(capsys):
    exit_code = cli.main([])

    payload = _read_payload(capsys)
    assert exit_code == 1
    assert payload == {
        "success": False,
        "ship_no": "",
        "exception": "ship_no 不能为空",
    }


def test_invalid_ship_no_returns_failure_json(capsys):
    exit_code = cli.main(["--ship-no", "FBA123"])

    payload = _read_payload(capsys)
    assert exit_code == 1
    assert payload == {
        "success": False,
        "ship_no": "FBA123",
        "exception": "ship_no 格式无效: FBA123",
    }


def test_success_returns_downloaded_excel_path(monkeypatch, tmp_path, capsys):
    excel_path = tmp_path / "SP260226004.xlsx"
    _write_consignment_excel(excel_path, 4)

    async def fake_download(ship_no: str) -> Path:
        assert ship_no == "SP260226004"
        return excel_path

    monkeypatch.setattr(cli, "download_consignment_excel_from_wms", fake_download)

    exit_code = cli.main(["--ship-no", "sp260226004"])

    payload = _read_payload(capsys)
    assert exit_code == 0
    assert payload == {
        "success": True,
        "ship_no": "SP260226004",
        "excel_path": str(excel_path),
        "source": "wms",
        "box_count": 4,
        "split_required": False,
        "split_excel_paths": [],
    }


def test_download_error_returns_failure_json(monkeypatch, capsys):
    async def fake_download(ship_no: str) -> Path:
        raise RuntimeError(f"WMS failed for {ship_no}")

    monkeypatch.setattr(cli, "download_consignment_excel_from_wms", fake_download)

    exit_code = cli.main(["--ship-no", "SP260226004"])

    payload = _read_payload(capsys)
    assert exit_code == 1
    assert payload == {
        "success": False,
        "ship_no": "SP260226004",
        "exception": "WMS failed for SP260226004",
    }


def test_split_four_boxes_does_not_create_split_files(tmp_path):
    excel_path = tmp_path / "SP260226004.xlsx"
    _write_consignment_excel(excel_path, 4)

    payload = cli.split_consignment_excel_by_box(excel_path)

    assert payload == {
        "box_count": 4,
        "split_required": False,
        "split_excel_paths": [],
    }
    assert not (tmp_path / "SP260226004-1.xlsx").exists()


def test_split_six_boxes_creates_five_plus_one(tmp_path):
    excel_path = tmp_path / "SP260226004.xlsx"
    _write_consignment_excel(excel_path, 6)

    payload = cli.split_consignment_excel_by_box(excel_path)

    assert payload["box_count"] == 6
    assert payload["split_required"] is True
    paths = [Path(path) for path in payload["split_excel_paths"]]
    assert [path.name for path in paths] == ["SP260226004-1.xlsx", "SP260226004-2.xlsx"]
    _assert_split_file(paths[0], expected_box_count=5)
    _assert_split_file(paths[1], expected_box_count=1)


def test_split_ten_boxes_creates_two_even_files(tmp_path):
    excel_path = tmp_path / "SP260226004.xlsx"
    _write_consignment_excel(excel_path, 10)

    payload = cli.split_consignment_excel_by_box(excel_path)

    paths = [Path(path) for path in payload["split_excel_paths"]]
    assert [path.name for path in paths] == ["SP260226004-1.xlsx", "SP260226004-2.xlsx"]
    _assert_split_file(paths[0], expected_box_count=5)
    _assert_split_file(paths[1], expected_box_count=5)


def test_split_twelve_boxes_creates_three_files(tmp_path):
    excel_path = tmp_path / "SP260226004.xlsx"
    _write_consignment_excel(excel_path, 12)

    payload = cli.split_consignment_excel_by_box(excel_path)

    paths = [Path(path) for path in payload["split_excel_paths"]]
    assert [path.name for path in paths] == [
        "SP260226004-1.xlsx",
        "SP260226004-2.xlsx",
        "SP260226004-3.xlsx",
    ]
    _assert_split_file(paths[0], expected_box_count=5)
    _assert_split_file(paths[1], expected_box_count=5)
    _assert_split_file(paths[2], expected_box_count=2)


def test_cli_success_returns_split_payload(monkeypatch, tmp_path, capsys):
    excel_path = tmp_path / "SP260226004.xlsx"
    _write_consignment_excel(excel_path, 6)

    async def fake_download(ship_no: str) -> Path:
        assert ship_no == "SP260226004"
        return excel_path

    monkeypatch.setattr(cli, "download_consignment_excel_from_wms", fake_download)

    exit_code = cli.main(["--ship-no", "SP260226004"])

    payload = _read_payload(capsys)
    assert exit_code == 0
    assert payload["box_count"] == 6
    assert payload["split_required"] is True
    assert [Path(path).name for path in payload["split_excel_paths"]] == [
        "SP260226004-1.xlsx",
        "SP260226004-2.xlsx",
    ]


def _assert_split_file(path: Path, *, expected_box_count: int) -> None:
    assert path.is_file()
    df = _read_excel(path)
    assert len(df) == expected_box_count * 2
    expected_boxes = list(range(1, expected_box_count + 1))
    assert sorted(df["箱子编号"].unique().tolist()) == expected_boxes
    assert sorted(df["箱序号"].unique().tolist()) == expected_boxes
