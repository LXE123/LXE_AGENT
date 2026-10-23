from __future__ import annotations

from contextlib import asynccontextmanager
import json
from types import SimpleNamespace
from unittest.mock import Mock

from aiohttp import ClientResponseError, RequestInfo, TooManyRedirects
from multidict import CIMultiDict, CIMultiDictProxy
import pytest
from yarl import URL


from services.agent_cli.mabang import export_store_msku_actual_inventory as cli
from services.mabang.amazon.fba.store_msku_actual_inventory import ActualInventoryResult


def test_success_returns_actual_inventory_path(monkeypatch, capsys) -> None:
    async def fake_export_store_msku_actual_inventory(store_name: str):
        assert store_name == "Amazon-Lerxiuer-FR"
        return ActualInventoryResult(
            store_name="Amazon-Lerxiuer-FR",
            source_msku_xlsx_path="artifacts/mabang_store_msku/202605251530-Amazon-Lerxiuer-FR_店铺MSKU数据.xlsx",
            source_msku_data_time="202605251530",
            unique_local_sku_count=120,
            detected_combo_sku_count=8,
            queried_warehouse_stock_sku_count=135,
            missing_warehouse_stock_skus=["SKU-A", "SKU-B"],
            shenzhen_warehouse_inventory_report_xlsx_path="artifacts/mabang_store_msku_inventory/202605251530-Amazon-Lerxiuer-FR_真实库存（深圳仓库）.xlsx",
            matched_warehouse_inventory_msku_row_count=118,
            missing_local_sku_msku_row_count=3,
            missing_warehouse_inventory_msku_row_count=2,
        )

    monkeypatch.setattr(cli, "export_store_msku_actual_inventory", fake_export_store_msku_actual_inventory)

    payload = cli.run({"store_name": "Amazon-Lerxiuer-FR"})
    assert payload == {
        "success": True,
        "store_name": "Amazon-Lerxiuer-FR",
        "warehouse_id": "1014318",
        "warehouse_name": "深圳仓库",
        "source_msku_xlsx_path": "artifacts/mabang_store_msku/202605251530-Amazon-Lerxiuer-FR_店铺MSKU数据.xlsx",
        "source_msku_data_time": "202605251530",
        "unique_local_sku_count": 120,
        "detected_combo_sku_count": 8,
        "queried_warehouse_stock_sku_count": 135,
        "matched_warehouse_inventory_msku_row_count": 118,
        "missing_local_sku_msku_row_count": 3,
        "missing_warehouse_inventory_msku_row_count": 2,
        "missing_warehouse_stock_sku_count": 2,
        "missing_warehouse_stock_skus": ["SKU-A", "SKU-B"],
        "shenzhen_warehouse_inventory_report_xlsx_path": "artifacts/mabang_store_msku_inventory/202605251530-Amazon-Lerxiuer-FR_真实库存（深圳仓库）.xlsx",
        "result_source": "mabang_store_msku_shenzhen_warehouse_inventory",
    }
    assert "stock_sku_count" not in payload
    assert "xlsx_path" not in payload
    assert "source" not in payload


def test_failure_returns_last_line_json(monkeypatch, capsys) -> None:
    async def fake_export_store_msku_actual_inventory(store_name: str):
        raise RuntimeError(f"inventory failed for {store_name}")

    monkeypatch.setattr(cli, "export_store_msku_actual_inventory", fake_export_store_msku_actual_inventory)

    payload = cli.run({"store_name": "Amazon-Lerxiuer-FR"})
    assert payload == {
        "success": False,
        "store_name": "Amazon-Lerxiuer-FR",
        "exception": "inventory failed for Amazon-Lerxiuer-FR",
        "auth_refresh_required": False,
    }


def test_terminal_failure_preserves_actual_error_without_requesting_refresh(monkeypatch):
    from services.mabang.errors import MabangAuthError
    from services.mabang.official_api import OfficialApiError
    for error in [OfficialApiError('店铺', '无匹配 profile_id=1403401'), MabangAuthError('实际认证错误')]:
        async def fail(name):
            raise error
        monkeypatch.setattr(cli, 'export_store_msku_actual_inventory', fail)
        payload = cli.run({'store_name': 'shop'})
        assert payload['auth_refresh_required'] is False
        assert payload['exception'] == str(error)


@pytest.mark.parametrize("error_type", [ClientResponseError, TooManyRedirects])
@pytest.mark.parametrize("search_token", ["synthetic-search-token", "synthetic +&/令牌"])
def test_export_request_exception_redacts_search_token_in_terminal(
    monkeypatch, tmp_path, capsys, caplog, error_type, search_token,
):
    from lxeskill import cli as lxeskill
    from services.mabang.amazon.fba import store_msku_actual_inventory as inventory

    base_url = "https://example.invalid/index.php?mod=warehouse.doexportwarehousestock&flag=1"
    monkeypatch.setattr(inventory, "_warehouse_export_url", lambda: base_url)
    requested_urls = []

    @asynccontextmanager
    async def fail_get(url, **kwargs):
        requested_urls.append(url)
        request_url = URL(url)
        assert request_url.query["searchToken"] == search_token
        info = RequestInfo(request_url, "GET", CIMultiDictProxy(CIMultiDict()), request_url)
        raise error_type(info, (), status=302, message="synthetic redirect boundary")
        yield  # pragma: no cover — the request fails while entering its context.

    get = Mock(side_effect=fail_get)
    monkeypatch.setattr(inventory, "erp_http_session", SimpleNamespace(get=get))

    async def export(store_name):
        return await inventory.download_warehouse_stock_xlsx(
            store_name=store_name, output_dir=tmp_path / "output",
            cookie_header="session=synthetic-cookie", search_token=search_token,
        )

    monkeypatch.setattr(cli, "export_store_msku_actual_inventory", export)
    monkeypatch.setenv("LXESKILL_SKILL_SCOPE", "mabang-store-shenzhen-inventory-export")
    monkeypatch.setenv("LXE_DATA_ROOT", str(tmp_path / "state"))
    monkeypatch.setenv("LXE_WORKSPACE_ROOT", str(tmp_path / "workspace"))

    assert lxeskill.main([
        "mabang", "store", "shenzhen-inventory", "export", "--store-name", "shop",
    ]) == lxeskill.EXIT_BUSINESS
    terminal = json.loads(capsys.readouterr().out.strip())
    assert terminal["ok"] is False
    message = terminal["error"]["message"]
    assert terminal["data"]["exception"] == message
    assert terminal["data"]["auth_refresh_required"] is False
    assert "302" in message and "synthetic redirect boundary" in message
    assert "mod=warehouse.doexportwarehousestock" in message
    assert "searchToken=[REDACTED]" in message
    encoded_token = requested_urls[0].partition("searchToken=")[2]
    for diagnostic_text in (json.dumps(terminal, ensure_ascii=False), caplog.text):
        assert search_token not in diagnostic_text
        assert encoded_token not in diagnostic_text
        assert "synthetic-cookie" not in diagnostic_text
    assert terminal["files"] == []
    get.assert_called_once()
    assert not list((tmp_path / "output").glob("*.xlsx"))


def test_html_business_error_reaches_terminal_without_files_or_auth_recovery(monkeypatch, tmp_path, capsys):
    from unittest.mock import AsyncMock
    from lxeskill import cli as lxeskill
    from services.mabang.amazon.fba import store_msku_actual_inventory as inventory
    from test_mabang_store_msku_actual_inventory import (
        _FakeResponse, _FakeSession, _fake_auth_context, WAREHOUSE_ERROR_HTML, WAREHOUSE_ERROR,
        SEARCH_TOKEN,
    )
    from test_source_verification import row, source

    source(tmp_path / "source/202610141349-shop_店铺MSKU数据.xlsx", [row(**{
        "父ASIN": "P", "商品链接": "https://example.test/A",
        **dict.fromkeys((*inventory.SALES_COLUMNS, *inventory.FBA_STOCK_COLUMNS), 0),
    })])
    session = _FakeSession([
        _FakeResponse(payload={"success": True, "searchToken": SEARCH_TOKEN}),
        _FakeResponse(body=WAREHOUSE_ERROR_HTML),
    ])
    monkeypatch.setattr(inventory, "erp_http_session", session)
    monkeypatch.setattr(inventory, "get_auth_context", _fake_auth_context)
    refresh = AsyncMock(side_effect=AssertionError("业务错误不得刷新认证"))
    monkeypatch.setattr(inventory, "refresh_mabang_auth", refresh)
    monkeypatch.setenv("LXESKILL_SKILL_SCOPE", "mabang-store-shenzhen-inventory-export")
    monkeypatch.setenv("LXE_DATA_ROOT", str(tmp_path / "state"))
    monkeypatch.setenv("LXE_WORKSPACE_ROOT", str(tmp_path / "workspace"))

    async def download(store_name):
        return await inventory.export_store_msku_actual_inventory(
            store_name, input_dir=tmp_path / "source", output_dir=tmp_path / "output",
        )

    monkeypatch.setattr(cli, "export_store_msku_actual_inventory", download)
    assert lxeskill.main(["mabang", "store", "shenzhen-inventory", "export", "--store-name", "shop"]) == lxeskill.EXIT_BUSINESS
    terminal = json.loads(capsys.readouterr().out.strip())
    assert terminal["ok"] is False
    assert WAREHOUSE_ERROR in terminal["error"]["message"]
    assert terminal["data"]["exception"] == terminal["error"]["message"]
    assert terminal["data"]["auth_refresh_required"] is False
    assert terminal["files"] == []
    assert SEARCH_TOKEN not in json.dumps(terminal)
    assert not list((tmp_path / "output").glob("*.xlsx"))
    assert len(session.calls) == 2
    refresh.assert_not_called()


def test_explicit_source_flag_reaches_service_through_standard_terminal(monkeypatch, tmp_path, capsys):
    from lxeskill import cli as lxeskill
    seen = []

    async def export(store_name, **kwargs):
        seen.append((store_name, kwargs))
        raise FileNotFoundError("指定源表不存在，不得回退")

    monkeypatch.setattr(cli, "export_store_msku_actual_inventory", export)
    monkeypatch.setenv("LXESKILL_SKILL_SCOPE", "mabang-store-shenzhen-inventory-export")
    monkeypatch.setenv("LXE_DATA_ROOT", str(tmp_path / "state"))
    path = str(tmp_path / "指定源表.xlsx")
    assert lxeskill.main([
        "mabang", "store", "shenzhen-inventory", "export", "--store-name", "shop",
        "--msku-source-xlsx-path", path,
    ]) == lxeskill.EXIT_BUSINESS
    assert seen == [("shop", {"msku_source_xlsx_path": path})]
    terminal = json.loads(capsys.readouterr().out.strip())
    assert terminal["ok"] is False and terminal["files"] == []
    assert "指定源表不存在" in terminal["error"]["message"]
    assert terminal["data"]["auth_refresh_required"] is False
