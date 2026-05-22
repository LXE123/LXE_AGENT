from __future__ import annotations

import json

from services.agent_cli.mabang import download_msku_detail_excel as cli
from services.mabang.amazon.fba.msku_detail import MskuDetailExcelResult


def _read_payload(capsys) -> dict:
    output = capsys.readouterr().out.strip().splitlines()
    assert output
    return json.loads(output[-1])


async def _noop_close_all_network_clients() -> None:
    return None


def test_missing_ship_no_returns_failure_json(monkeypatch, capsys):
    monkeypatch.setattr(cli, "close_all_network_clients", _noop_close_all_network_clients)

    exit_code = cli.main([])

    payload = _read_payload(capsys)
    assert exit_code == 1
    assert payload == {
        "success": False,
        "ship_no": "",
        "exception": "ship_no 不能为空",
    }


def test_invalid_ship_no_returns_failure_json(monkeypatch, capsys):
    monkeypatch.setattr(cli, "close_all_network_clients", _noop_close_all_network_clients)

    exit_code = cli.main(["--ship-no", "FBA123"])

    payload = _read_payload(capsys)
    assert exit_code == 1
    assert payload == {
        "success": False,
        "ship_no": "FBA123",
        "exception": "ship_no 格式无效: FBA123",
    }


def test_success_returns_downloaded_msku_detail_path(monkeypatch, capsys):
    monkeypatch.setattr(cli, "close_all_network_clients", _noop_close_all_network_clients)

    async def fake_download(ship_no: str):
        assert ship_no == "SP260414001"
        return MskuDetailExcelResult(
            ship_no="SP260414001",
            delivery_file_path="artifacts/mabang_fba_delivery/SP260414001_370502.csv",
            delivery_file_source="local",
            msku_count=41,
            id_count=58,
            excel_path="artifacts/mabang_msku_detail/SP260414001_msku_detail.xls",
            xlsx_path="artifacts/mabang_msku_detail/SP260414001_msku_detail.xlsx",
            converted=True,
            raw_excel_deleted=True,
            matched_detail_count=40,
            shop_mismatch_count=1,
        )

    monkeypatch.setattr(cli, "download_msku_detail_excel", fake_download)

    exit_code = cli.main(["--ship-no", "sp260414001"])

    payload = _read_payload(capsys)
    assert exit_code == 0
    assert payload == {
        "success": True,
        "ship_no": "SP260414001",
        "delivery_file_path": "artifacts/mabang_fba_delivery/SP260414001_370502.csv",
        "delivery_file_source": "local",
        "msku_count": 41,
        "id_count": 58,
        "excel_path": "artifacts/mabang_msku_detail/SP260414001_msku_detail.xls",
        "xlsx_path": "artifacts/mabang_msku_detail/SP260414001_msku_detail.xlsx",
        "converted": True,
        "raw_excel_deleted": True,
        "matched_detail_count": 40,
        "shop_mismatch_count": 1,
        "shop_mismatch_sheet": "店铺不一致",
        "source": "mabang_msku_detail",
    }


def test_success_accepts_delivery_no_alias(monkeypatch, capsys):
    monkeypatch.setattr(cli, "close_all_network_clients", _noop_close_all_network_clients)

    async def fake_download(ship_no: str):
        assert ship_no == "SP260414001"
        return MskuDetailExcelResult(
            ship_no="SP260414001",
            delivery_file_path="artifacts/mabang_fba_delivery/SP260414001_370502.csv",
            delivery_file_source="downloaded",
            msku_count=1,
            id_count=1,
            excel_path="artifacts/mabang_msku_detail/SP260414001_msku_detail.xlsx",
            xlsx_path="artifacts/mabang_msku_detail/SP260414001_msku_detail.xlsx",
            converted=False,
            raw_excel_deleted=False,
            matched_detail_count=1,
            shop_mismatch_count=0,
        )

    monkeypatch.setattr(cli, "download_msku_detail_excel", fake_download)

    exit_code = cli.main(["--delivery-no", "sp260414001"])

    payload = _read_payload(capsys)
    assert exit_code == 0
    assert payload["ship_no"] == "SP260414001"
    assert payload["delivery_file_source"] == "downloaded"


def test_download_error_returns_failure_json(monkeypatch, capsys):
    monkeypatch.setattr(cli, "close_all_network_clients", _noop_close_all_network_clients)

    async def fake_download(ship_no: str):
        raise RuntimeError(f"download failed for {ship_no}")

    monkeypatch.setattr(cli, "download_msku_detail_excel", fake_download)

    exit_code = cli.main(["--ship-no", "SP260414001"])

    payload = _read_payload(capsys)
    assert exit_code == 1
    assert payload == {
        "success": False,
        "ship_no": "SP260414001",
        "exception": "download failed for SP260414001",
    }
