from __future__ import annotations


from services.agent_cli.mabang import download_store_msku_excel as cli
from services.mabang.amazon.fba.store_msku import StoreMskuExcelResult


def test_missing_store_id_returns_failure_json(monkeypatch, capsys) -> None:

    payload = cli.run({"id_type": 'shopId'})
    assert payload == {
        "success": False,
        "store_name": "",
        "store_id": "",
        "id_type": "shopId",
        "exception": "store_id 不能为空",
    }


def test_missing_id_type_returns_failure_json(monkeypatch, capsys) -> None:

    payload = cli.run({"store_id": '697456821'})
    assert payload == {
        "success": False,
        "store_name": "",
        "store_id": "697456821",
        "id_type": "",
        "exception": "id_type 不能为空",
    }


def test_invalid_id_type_returns_failure_json(monkeypatch, capsys) -> None:

    payload = cli.run({"store_id": '697456821', "id_type": 'shop_id'})
    assert payload == {
        "success": False,
        "store_name": "",
        "store_id": "697456821",
        "id_type": "shop_id",
        "exception": "id_type 只支持 fbaWarehouseIds[] 或 shopId: shop_id",
    }


def test_success_returns_downloaded_store_msku_path(monkeypatch, capsys) -> None:
    async def fake_download_store_msku_excel(store_id: str, id_type: str, *, store_name: str = ""):
        assert store_id == "697456821"
        assert id_type == "shopId"
        assert store_name == "Amazon-Lerxiuer-FR"
        return StoreMskuExcelResult(
            store_name="Amazon-Lerxiuer-FR",
            store_id="697456821",
            id_type="shopId",
            id_count=123,
            xlsx_path="artifacts/mabang_store_msku/202605251530-Amazon-Lerxiuer-FR_店铺MSKU数据.xlsx",
            converted=True,
            raw_excel_deleted=True,
        )

    monkeypatch.setattr(cli, "download_store_msku_excel", fake_download_store_msku_excel)

    payload = cli.run({"store_id": '697456821', "id_type": 'shopId', "store_name": 'Amazon-Lerxiuer-FR'})
    assert payload == {
        "success": True,
        "store_name": "Amazon-Lerxiuer-FR",
        "store_id": "697456821",
        "id_type": "shopId",
        "id_count": 123,
        "xlsx_path": "artifacts/mabang_store_msku/202605251530-Amazon-Lerxiuer-FR_店铺MSKU数据.xlsx",
        "converted": True,
        "raw_excel_deleted": True,
        "source": "mabang_store_msku_download",
    }
