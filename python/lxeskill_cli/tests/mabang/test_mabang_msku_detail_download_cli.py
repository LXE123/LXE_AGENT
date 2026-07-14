from __future__ import annotations


from services.agent_cli.mabang import download_msku_detail_excel as cli
from services.mabang.amazon.fba.msku_detail import MskuDetailExcelResult


def test_success_returns_downloaded_msku_detail_path(monkeypatch, capsys):

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

    payload = cli.run({"ship_no": 'sp260414001'})
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

    payload = cli.run({"delivery_no": 'sp260414001'})
    assert payload["ship_no"] == "SP260414001"
    assert payload["delivery_file_source"] == "downloaded"
