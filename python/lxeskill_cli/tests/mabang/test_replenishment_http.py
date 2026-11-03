"""Real loopback HTTP for catalog sessions, rejection policy and warehouse export."""
import asyncio
from contextlib import asynccontextmanager
from contextvars import copy_context
from pathlib import Path
from types import SimpleNamespace

import aiohttp
from aiohttp import web
import pytest

from replenishment_cases import STORE, batch, write_table
from services.mabang import official_api as api
from services.mabang.amazon.fba import sku_catalog, store_msku_actual_inventory as inventory
from services.mabang.amazon.fba import unlinked_shipments
from shared.infra.cloud_async import AsyncCloudClient


@asynccontextmanager
async def server(handler):
    app = web.Application()
    app.router.add_route("*", "/{path:.*}", handler)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    try:
        # localhost lets the actual cookie policy evaluate domain/path attributes.
        yield f"http://localhost:{site._server.sockets[0].getsockname()[1]}"
    finally:
        await runner.cleanup()


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setenv("LXE_DATA_ROOT", str(tmp_path / "state"))
    for name in ("LXE_DATA_SERVER_API_KEY", "LXE_DATA_SERVER_FALLBACK_API_KEY", "LXE_ERP_API_KEY"):
        monkeypatch.delenv(name, raising=False)


def test_catalog_paginates_reuses_connection_and_does_not_forward_response_cookie(monkeypatch):
    requests, connections = [], set()
    async def scenario():
        async def respond(request):
            body = await request.json()
            requests.append((request.path, body, dict(request.headers)))
            connections.add(request.transport)
            if request.path.endswith("stock-skus/search"):
                data = {"data": None, "nextCursor": ""} if body.get("cursor") else {
                    "data": [{"stockSku": "S"}], "nextCursor": "next"}
            else:
                data = {"data": [{"comboSku": "C", "comboProductDetail": [{"stockSku": "CHILD", "quantity": 2}]}],
                        "page": 1, "rowsPerPage": 20, "total": 1}
            return web.json_response({"code": 200, "data": data}, headers={"Set-Cookie": "poison=hidden; Path=/"})
        async with server(respond) as url:
            monkeypatch.setenv("LXE_DATA_SERVER_URL", url)
            result = await sku_catalog.fetch_local_sku_definitions(["S", "C", "S", ""])
            assert [(item.local_sku, item.stock_type) for item in result] == [("S", 1), ("C", 2)]
            assert [(item.stock_sku, item.quantity) for item in result[1].components] == [("CHILD", 2)]
    asyncio.run(scenario())
    assert len(requests) == 3 and len(connections) == 1
    assert requests[1][1]["cursor"] == "next"
    for _, _, headers in requests:
        assert not {"cookie", "authorization", "proxy-authorization"} & {key.lower() for key in headers}


@pytest.mark.parametrize("status", [403, 429, 503])
def test_http_rejection_vs_temporary_failure_is_observable_in_attempts_and_error(monkeypatch, status):
    attempts = []
    async def scenario():
        async def respond(request):
            attempts.append(request.path)
            if len(attempts) == 1:
                return web.json_response({"detail": "remote rejection", "token": "private-fixture-token"},
                                         status=status, headers={"Retry-After": "0"})
            return web.json_response({"code": 200, "data": {"accepted": True}})
        async with server(respond) as url:
            monkeypatch.setenv("LXE_DATA_SERVER_URL", url)
            metrics = api.RequestMetrics()
            with api.observe_requests(metrics):
                if status == 503:
                    assert (await api.post_json("stock-skus/search", {}, context="catalog"))["data"]["accepted"]
                else:
                    with pytest.raises(api.OfficialApiError) as caught:
                        await api.post_json("stock-skus/search", {}, context="catalog")
                    assert f"HTTP {status}" in str(caught.value) and "remote rejection" in str(caught.value)
                    assert "private-fixture-token" not in str(caught.value)
            assert metrics.http_attempt_count == len(attempts)
            assert metrics.retry_count == (1 if status == 503 else 0)
    asyncio.run(scenario())
    assert len(attempts) == (2 if status == 503 else 1)


@pytest.mark.parametrize("status", [403, 429])
def test_rejected_response_that_times_out_reading_body_is_not_retried(monkeypatch, status):
    async def scenario():
        attempts = []
        release = asyncio.Event()
        async def respond(request):
            attempts.append(request.path)
            response = web.StreamResponse(status=status, headers={"Content-Length": "1"})
            await response.prepare(request)
            await release.wait()
            return response
        async with server(respond) as url:
            monkeypatch.setenv("LXE_DATA_SERVER_URL", url)
            # Shorten only the real external transport deadline; no request/result is mocked.
            monkeypatch.setattr(api, "AsyncCloudClient", lambda base, **_: AsyncCloudClient(base, timeout=0.5))
            try:
                with pytest.raises(api.OfficialApiError, match=f"HTTP {status}.*TimeoutError"):
                    await api.post_json("stock-skus/search", {}, context="catalog")
                assert len(attempts) == 1
            finally:
                release.set()
    asyncio.run(scenario())


def test_inherited_context_can_make_a_new_request_after_original_session_closes(monkeypatch):
    async def scenario():
        connections = set()
        async def respond(request):
            connections.add(request.transport)
            return web.json_response({"code": 200, "data": {"value": 7}})
        async with server(respond) as url:
            monkeypatch.setenv("LXE_DATA_SERVER_URL", url)
            async def query():
                return await api.post_json("stock-skus/search", {}, context="catalog")
            async with api.catalog_client_scope():
                assert (await query())["data"]["value"] == 7
                inherited = copy_context()
            assert (await asyncio.create_task(query(), context=inherited))["data"]["value"] == 7
            assert len(connections) == 2
    asyncio.run(scenario())


@pytest.mark.parametrize("response_kind", ["xlsx", "captured-error", "missing-token", "forbidden"])
def test_selected_source_uses_current_search_cookie_and_token_and_only_publishes_real_inventory(
    monkeypatch, tmp_path, response_kind,
):
    source, _, _ = batch(tmp_path / "chosen")
    latest, _, _ = batch(tmp_path / "latest")
    stock = write_table(tmp_path / "stock.xlsx", [{"库存SKU编号": "S", "可用库存量": -3, "仓位库存": 999}]).read_bytes()
    token = "current+/&=?token"
    observed = []
    async def auth(**_):
        return SimpleNamespace(cookies_by_domain={".mabangerp.com": [
            {"name": "PHPSESSID", "value": "initial", "domain": ".mabangerp.com"}]})
    async def scenario():
        async def respond(request):
            observed.append((request.path, request.cookies.get("PHPSESSID"), request.query.getall("searchToken", [])))
            if request.path == "/search":
                assert (await request.post())["stockSkuStr"].strip() == "S"
                data = {"success": True} if response_kind == "missing-token" else {"success": True, "searchToken": token}
                response = web.json_response(data)
                response.set_cookie("PHPSESSID", "rotated", path="/")
                return response
            if response_kind == "forbidden":
                return web.Response(status=403, text="warehouse denied")
            if response_kind == "captured-error":
                return web.Response(body=(Path(__file__).parent / "fixtures/warehouse_search_overwritten.html").read_bytes())
            return web.Response(body=stock)
        async with server(respond) as url:
            monkeypatch.setenv("MABANG_WAREHOUSE_STOCK_SEARCH_URL", url + "/search")
            monkeypatch.setenv("MABANG_WAREHOUSE_STOCK_EXPORT_URL", url + "/export?searchToken=stale")
            monkeypatch.setattr(inventory, "get_auth_context", auth)  # Only external credential acquisition.
            async with aiohttp.ClientSession(cookie_jar=aiohttp.DummyCookieJar()) as transport:
                monkeypatch.setattr(inventory, "erp_http_session", transport)
                operation = inventory.export_store_msku_actual_inventory(
                    STORE, msku_source_xlsx_path=source, input_dir=latest.parent, output_dir=tmp_path / "out")
                if response_kind == "xlsx":
                    result = await operation
                    assert Path(result.source_msku_xlsx_path) == source
                    from openpyxl import load_workbook
                    book = load_workbook(result.shenzhen_warehouse_inventory_report_xlsx_path, data_only=True)
                    try:
                        ws = book["真实库存（深圳仓库）-库存sku"]
                        data = dict(zip([cell.value for cell in ws[1]], next(ws.iter_rows(min_row=2, values_only=True))))
                        assert data["MSKU"] == "SEA" and data["真实库存（深圳仓库）数量"] == -3
                    finally:
                        book.close()
                else:
                    expected = {"captured-error": "查询条件已被新的搜索覆盖", "missing-token": "searchToken", "forbidden": "403.*warehouse denied"}[response_kind]
                    with pytest.raises(Exception, match=expected):
                        await operation
                    assert not list((tmp_path / "out").glob("*真实库存*.xlsx"))
    asyncio.run(scenario())
    assert observed == ([("/search", "initial", [])] if response_kind == "missing-token" else
                        [("/search", "initial", []), ("/export", "rotated", [token])])


def test_unlinked_status_failure_retains_stage_and_redacts_secrets_in_cli_result(monkeypatch, tmp_path):
    from services.commands.mabang import download_store_unlinked_shipments as command
    calls = []
    async def response(request):
        calls.append(request.path)
        if request.path == "/shops":
            return web.json_response({"code": 200, "data": {"shop": [{"id": 101, "name": STORE}]}})
        return web.json_response({"message": "warehouse denied", "searchToken": "private-search-token"}, status=403)
    async def token(**_):
        return "fixture-credential"
    monkeypatch.setattr(unlinked_shipments, "get_fba_free_token", token)
    async def scenario():
        async with server(response) as url:
            monkeypatch.setenv("FBA_SHOP_COUNTRY_API_URL", url + "/shops")
            monkeypatch.setenv("FBA_DELIVERY_LIST_API_URL", url + "/list")
            def execute():
                from shared.infra.net import close_all_aiohttp_sessions
                try:
                    return command.run({"store_name": STORE})
                finally:
                    asyncio.run(close_all_aiohttp_sessions())
            return await asyncio.to_thread(execute)
    result = asyncio.run(scenario())
    assert not result["success"]
    diagnostic = result["exception"]
    assert all(text in diagnostic for text in ("WMS待配货", "查询数量", "403", "warehouse denied"))
    assert "private-search-token" not in diagnostic
    assert len(calls) == 2
