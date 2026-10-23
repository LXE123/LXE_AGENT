"""Catalog-only session ownership, real loopback HTTP and unchanged failure contracts."""
import asyncio
from contextlib import asynccontextmanager
from contextvars import copy_context
from types import SimpleNamespace

import aiohttp
from aiohttp import web
import pytest

from services.mabang import official_api as http
from services.mabang.amazon.fba import sku_catalog as catalog
from services.mabang.amazon.fba import store_msku as msku
from services.mabang.amazon.fba.store_resolver import FbaStore
from shared.infra.cloud_async import AsyncCloudClient


@asynccontextmanager
async def no_reuse():
    yield


def stock_page(keys=(), cursor=""):
    return {"code": 200, "data": {"data": [{"stockSku": k} for k in keys] or None, "nextCursor": cursor}}


def combo_page(sku):
    return {"code": 200, "data": {"data": [{"comboSku": sku, "comboProductDetail": [
        {"stockSku": "CHILD", "quantity": 2}]}], "page": 1, "rowsPerPage": 20, "total": 1}}


@pytest.mark.parametrize("reuse", [False, True])
def test_actual_http_pagination_retry_cookie_and_cleanup(monkeypatch, reuse):
    clients = []
    calls = []
    retried = False

    async def scenario():
        nonlocal retried

        async def handler(request):
            nonlocal retried
            body = await request.json()
            calls.append((request.path, body.copy(), dict(request.headers)))
            if request.path.endswith("stock-skus/search"):
                payload = stock_page() if body.get("cursor") else stock_page(["S"], "end")
            elif body["comboSku"] == "C1" and not retried:
                retried = True
                return web.json_response({"detail": "limited"}, status=429, headers={"Retry-After": "0"})
            elif body["comboSku"] == "C0":
                payload = combo_page("C0")
                payload["data"].update(total=21, page=body["page"])
                if body["page"] == 1:
                    payload["data"]["data"] = [{"comboSku": f"similar-{i}"} for i in range(20)]
            else:
                payload = combo_page(body["comboSku"])
            return web.json_response(payload, headers={"Set-Cookie": "poison=not-forwarded; Path=/"})

        app = web.Application()
        app.router.add_post("/api/v1/data-sources/mabang/{tail:.*}", handler)
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, "127.0.0.1", 0)
        await site.start()
        assert site._server.sockets
        monkeypatch.setenv("LXE_DATA_SERVER_URL", f"http://127.0.0.1:{site._server.sockets[0].getsockname()[1]}")
        monkeypatch.setenv("HTTP_PROXY", "http://127.0.0.1:1")

        def factory(*args, **kwargs):
            client = AsyncCloudClient(*args, **kwargs)
            clients.append(client)
            return client

        monkeypatch.setattr(http, "AsyncCloudClient", factory)
        if not reuse:
            monkeypatch.setattr(catalog, "catalog_client_scope", no_reuse)
        try:
            result = await catalog.fetch_local_sku_definitions(["S", "C0", "C1", "C2", "C3", "C0", ""])
            assert [(r.local_sku, r.stock_type) for r in result] == [("S", 1), *[(f"C{i}", 2) for i in range(4)]]
            assert all(r.components[0].quantity == 2 for r in result[1:])
        finally:
            await runner.cleanup()

    asyncio.run(scenario())
    assert len(calls) == 8
    assert len(clients) == (1 if reuse else 7)
    assert all(c._session.closed for c in clients)
    assert all(isinstance(c._session.cookie_jar, aiohttp.DummyCookieJar) and not c._session.trust_env
               and c.timeout == 60 and c.max_response_bytes is None for c in clients)
    for path, body, headers in calls:
        assert not {"cookie", "authorization", "proxy-authorization"} & {k.lower() for k in headers}
        assert headers["X-LXE-Client"] == "cli"
        if path.endswith("stock-skus/search"):
            assert body["maxRows"] == 1000 and body["way"] == 2
        else:
            assert body["rowsPerPage"] == 20 and body["showCost"] == 0


@pytest.fixture
def fake_clients(monkeypatch):
    monkeypatch.setenv("LXE_DATA_SERVER_URL", "https://first.test")
    clients = []

    class Client:
        def __init__(self, base, **kwargs):
            self.base = base
            self.closed = False
            self.calls = []
            clients.append(self)

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            self.closed = True

        async def request_json(self, method, path, *, json_body):
            assert not self.closed
            self.calls.append(path)
            payload = stock_page() if path.endswith("stock-skus/search") else combo_page(json_body.get("comboSku", "C"))
            return SimpleNamespace(status_code=200, payload=payload, headers={})

    monkeypatch.setattr(http, "AsyncCloudClient", Client)
    return clients, Client


def test_concurrent_stores_and_sequential_tasks_do_not_share_clients(fake_clients, monkeypatch):
    clients, Client = fake_clients
    original = Client.request_json

    async def scenario():
        barrier = asyncio.Event()
        ready = 0

        async def request(self, *args, **kwargs):
            nonlocal ready
            if args[1].endswith("stock-skus/search"):
                ready += 1
                if ready >= 2:
                    barrier.set()
                await barrier.wait()
            return await original(self, *args, **kwargs)

        monkeypatch.setattr(Client, "request_json", request)
        first, second = await asyncio.gather(*[
            catalog.fetch_sku_catalog_snapshot(FbaStore(name, name, "shopId"), ["COMMON"])
            for name in ("store-a", "store-b")
        ])
        assert first.store_name == "store-a" and second.store_name == "store-b"
        assert first.skus == second.skus
        assert len(clients) == 2 and all(c.closed for c in clients)
        await catalog.fetch_local_sku_definitions(["COMMON"])
        assert len(clients) == 3 and all(c.closed for c in clients)

    asyncio.run(scenario())


def test_other_endpoints_origin_changes_and_nested_scopes_are_isolated(fake_clients, monkeypatch):
    clients, _ = fake_clients

    async def call(endpoint="stock-skus/search"):
        return await http.post_json(endpoint, {}, context="test")

    async def scenario():
        async with http.catalog_client_scope():
            await call()
            await call("shops/list")
            assert len(clients) == 2 and clients[1].closed and not clients[0].closed
            monkeypatch.setenv("LXE_DATA_SERVER_URL", "https://second.test")
            await call()
            assert clients[2].base == "https://second.test" and clients[2].closed
            monkeypatch.setenv("LXE_DATA_SERVER_URL", "https://first.test")
            async with http.catalog_client_scope():
                await call()
            assert clients[3].closed and not clients[0].closed
            await call()
            assert len(clients) == 4 and len(clients[0].calls) == 2
        assert all(c.closed for c in clients)
        await call()
        assert len(clients) == 5 and clients[4].closed

    asyncio.run(scenario())


def test_inherited_context_cannot_reuse_a_finished_scope(fake_clients):
    clients, _ = fake_clients

    async def call():
        return await http.post_json("stock-skus/search", {}, context="test")

    async def scenario():
        async with http.catalog_client_scope():
            await call()
            inherited = copy_context()
        assert clients[0].closed
        await asyncio.create_task(call(), context=inherited)
        assert len(clients) == 2 and all(c.closed for c in clients)

    asyncio.run(scenario())


@pytest.mark.parametrize("failure", ["stock", "combo", "cancel"])
def test_failures_and_cancellation_close_scope_after_workers(fake_clients, monkeypatch, caplog, failure):
    caplog.set_level("INFO", logger=msku.__name__)
    clients, Client = fake_clients
    original = Client.request_json
    original_exit = Client.__aexit__

    async def scenario():
        entered = asyncio.Event()
        active = 0
        observed = []

        async def close(self, *args):
            assert active == 0
            await original_exit(self, *args)

        async def request(self, *args, **kwargs):
            nonlocal active
            observed.append(args[1])
            is_combo = args[1].endswith("combo-skus/search")
            if failure == "stock" and not is_combo or failure == "combo" and is_combo:
                return SimpleNamespace(status_code=403, payload={"detail": "actual-denied"}, headers={})
            if failure == "cancel" and is_combo:
                active += 1
                entered.set()
                try:
                    await asyncio.Event().wait()
                finally:
                    active -= 1
            return await original(self, *args, **kwargs)

        monkeypatch.setattr(Client, "request_json", request)
        monkeypatch.setattr(Client, "__aexit__", close)
        async def verify():
            with msku._timed_export_stage("verify_sku_types"):
                return await catalog.fetch_local_sku_definitions([f"C{i}" for i in range(8)])

        task = asyncio.create_task(verify())
        if failure == "cancel":
            await entered.wait()
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        else:
            with pytest.raises(http.OfficialApiError, match="actual-denied"):
                await task
        assert active == 0 and len(clients) == 1 and clients[0].closed
        if failure == "stock":
            assert observed == [http.ROOT + "stock-skus/search"]
        if failure == "cancel":
            messages = [record.getMessage() for record in caplog.records if record.name == msku.__name__]
            assert len(messages) == 1
            assert "stage=verify_sku_types status=cancelled duration_ms=" in messages[0]

    asyncio.run(scenario())
