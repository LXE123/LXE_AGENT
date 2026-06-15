from __future__ import annotations

import json

from agent_runtime.skill_index import load_skill_index
from services.agent_cli.mabang import download_store_msku_excel as cli
from services.mabang.amazon.fba.store_msku import StoreMskuExcelResult


def _read_payload(capsys) -> dict:
    output = capsys.readouterr().out.strip().splitlines()
    assert output
    return json.loads(output[-1])


def test_missing_store_id_returns_failure_json(monkeypatch, capsys) -> None:
    close_calls: list[str] = []

    async def fake_close_all_network_clients() -> None:
        close_calls.append("close")

    monkeypatch.setattr(cli, "close_all_network_clients", fake_close_all_network_clients)

    exit_code = cli.main(["--id-type", "shopId"])

    payload = _read_payload(capsys)
    assert exit_code == 1
    assert payload == {
        "success": False,
        "store_name": "",
        "store_id": "",
        "id_type": "shopId",
        "exception": "store_id 不能为空",
    }
    assert close_calls == ["close"]


def test_missing_id_type_returns_failure_json(monkeypatch, capsys) -> None:
    close_calls: list[str] = []

    async def fake_close_all_network_clients() -> None:
        close_calls.append("close")

    monkeypatch.setattr(cli, "close_all_network_clients", fake_close_all_network_clients)

    exit_code = cli.main(["--store-id", "697456821"])

    payload = _read_payload(capsys)
    assert exit_code == 1
    assert payload == {
        "success": False,
        "store_name": "",
        "store_id": "697456821",
        "id_type": "",
        "exception": "id_type 不能为空",
    }
    assert close_calls == ["close"]


def test_invalid_id_type_returns_failure_json(monkeypatch, capsys) -> None:
    close_calls: list[str] = []

    async def fake_close_all_network_clients() -> None:
        close_calls.append("close")

    monkeypatch.setattr(cli, "close_all_network_clients", fake_close_all_network_clients)

    exit_code = cli.main(["--store-id", "697456821", "--id-type", "shop_id"])

    payload = _read_payload(capsys)
    assert exit_code == 1
    assert payload == {
        "success": False,
        "store_name": "",
        "store_id": "697456821",
        "id_type": "shop_id",
        "exception": "id_type 只支持 fbaWarehouseIds[] 或 shopId: shop_id",
    }
    assert close_calls == ["close"]


def test_missing_store_name_returns_failure_json(monkeypatch, capsys) -> None:
    close_calls: list[str] = []

    async def fake_close_all_network_clients() -> None:
        close_calls.append("close")

    monkeypatch.setattr(cli, "close_all_network_clients", fake_close_all_network_clients)

    exit_code = cli.main(["--store-id", "697456821", "--id-type", "shopId"])

    payload = _read_payload(capsys)
    assert exit_code == 1
    assert payload == {
        "success": False,
        "store_name": "",
        "store_id": "697456821",
        "id_type": "shopId",
        "exception": "store_name 不能为空",
    }
    assert close_calls == ["close"]


def test_success_returns_downloaded_store_msku_path(monkeypatch, capsys) -> None:
    close_calls: list[str] = []

    async def fake_close_all_network_clients() -> None:
        close_calls.append("close")

    async def fake_download_store_msku_excel(store_id: str, id_type: str, *, store_name: str = ""):
        assert store_id == "697456821"
        assert id_type == "shopId"
        assert store_name == "Amazon-Lerxiuer-FR"
        return StoreMskuExcelResult(
            store_name="Amazon-Lerxiuer-FR",
            store_id="697456821",
            id_type="shopId",
            id_count=123,
            xlsx_path="artifacts/mabang_store_msku/202605251530-Amazon-Lerxiuer-FR_msku_data.xlsx",
            converted=True,
            raw_excel_deleted=True,
        )

    monkeypatch.setattr(cli, "close_all_network_clients", fake_close_all_network_clients)
    monkeypatch.setattr(cli, "download_store_msku_excel", fake_download_store_msku_excel)

    exit_code = cli.main(
        [
            "--store-id",
            "697456821",
            "--id-type",
            "shopId",
            "--store-name",
            "Amazon-Lerxiuer-FR",
        ]
    )

    payload = _read_payload(capsys)
    assert exit_code == 0
    assert payload == {
        "success": True,
        "store_name": "Amazon-Lerxiuer-FR",
        "store_id": "697456821",
        "id_type": "shopId",
        "id_count": 123,
        "xlsx_path": "artifacts/mabang_store_msku/202605251530-Amazon-Lerxiuer-FR_msku_data.xlsx",
        "converted": True,
        "raw_excel_deleted": True,
        "source": "mabang_store_msku_download",
    }
    assert close_calls == ["close"]


def test_download_error_returns_failure_json(monkeypatch, capsys) -> None:
    close_calls: list[str] = []

    async def fake_close_all_network_clients() -> None:
        close_calls.append("close")

    async def fake_download_store_msku_excel(store_id: str, id_type: str, *, store_name: str = ""):
        raise RuntimeError(f"download failed for {store_id}")

    monkeypatch.setattr(cli, "close_all_network_clients", fake_close_all_network_clients)
    monkeypatch.setattr(cli, "download_store_msku_excel", fake_download_store_msku_excel)

    exit_code = cli.main(
        [
            "--store-id",
            "697456821",
            "--id-type",
            "shopId",
            "--store-name",
            "Amazon-Lerxiuer-FR",
        ]
    )

    payload = _read_payload(capsys)
    assert exit_code == 1
    assert payload == {
        "success": False,
        "store_name": "Amazon-Lerxiuer-FR",
        "store_id": "697456821",
        "id_type": "shopId",
        "exception": "download failed for 697456821",
    }
    assert close_calls == ["close"]


def test_skill_index_loads_mabang_fba_store_msku_download() -> None:
    manifest = load_skill_index(force_reload=True).get("replenishment-msku-download")

    assert manifest is not None
    assert manifest.name == "replenishment-msku-download"
    assert manifest.type == "amazon_replenish"
