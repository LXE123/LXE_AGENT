"""Catalog-only session ownership, real loopback HTTP and unchanged failure contracts."""
import asyncio
from contextvars import copy_context
from types import SimpleNamespace

from aiohttp import web
import pytest

from services.mabang import official_api as http
from services.mabang.amazon.fba import sku_catalog as catalog
from shared.infra.cloud_async import AsyncCloudClient


def stock_page(keys=(), cursor=""):
    return {"code": 200, "data": {"data": [{"stockSku": k} for k in keys] or None, "nextCursor": cursor}}


def combo_page(sku):
    return {"code": 200, "data": {"data": [{"comboSku": sku, "comboProductDetail": [
        {"stockSku": "CHILD", "quantity": 2}]}], "page": 1, "rowsPerPage": 20, "total": 1}}


@pytest.mark.parametrize("status", [403, 429])
def test_rejection_before_body_timeout_does_not_retry(status):
    async def scenario():
        calls = 0
        release = asyncio.Event()

        async def handler(request):
            nonlocal calls
            calls += 1
            if calls > 1:
                return web.json_response({"code": 200})
            response = web.StreamResponse(status=status, headers={"Content-Length": "1"})
            await response.prepare(request)
            await release.wait()
            return response

        app = web.Application()
        app.router.add_post("/api/v1/data-sources/mabang/stock-skus/search", handler)
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, "127.0.0.1", 0)
        await site.start()
        base_url = f"http://127.0.0.1:{site._server.sockets[0].getsockname()[1]}"
        try:
            async with AsyncCloudClient(base_url, timeout=0.5) as client:
                with pytest.raises(http.OfficialApiError, match=f"HTTP {status}.*TimeoutError"):
                    await http._post_with_client(client, "stock-skus/search", {}, context="test", metrics=None)
            assert calls == 1
        finally:
            release.set()
            await runner.cleanup()

    asyncio.run(scenario())


def test_inherited_context_cannot_reuse_a_finished_scope(monkeypatch):
    clients = []

    class Client:
        def __init__(self, *args, **kwargs):
            self.closed = False
            clients.append(self)

        async def __aenter__(self): return self
        async def __aexit__(self, *args): self.closed = True
        async def request_json(self, *args, **kwargs):
            assert not self.closed
            return SimpleNamespace(status_code=200, payload={"code": 200})

    monkeypatch.setenv("LXE_DATA_SERVER_URL", "https://example.test")
    monkeypatch.setattr(http, "AsyncCloudClient", Client)

    async def scenario():
        async def call():
            await http.post_json("stock-skus/search", {}, context="test")

        async with http.catalog_client_scope():
            await call()
            inherited = copy_context()
        assert clients[0].closed
        await asyncio.create_task(call(), context=inherited)
        assert len(clients) == 2 and all(client.closed for client in clients)

    asyncio.run(scenario())


def test_actual_http_pagination_retry_cookie_and_cleanup(monkeypatch):
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
                return web.json_response({"detail": "temporarily unavailable"}, status=503)
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
        try:
            result = await catalog.fetch_local_sku_definitions(["S", "C0", "C1", "C2", "C3", "C0", ""])
            assert [(r.local_sku, r.stock_type) for r in result] == [("S", 1), *[(f"C{i}", 2) for i in range(4)]]
            assert all(r.components[0].quantity == 2 for r in result[1:])
        finally:
            await runner.cleanup()

    asyncio.run(scenario())
    assert len(calls) == 8
    assert len(clients) == 1
    assert all(c._session.closed for c in clients)
    for path, body, headers in calls:
        assert not {"cookie", "authorization", "proxy-authorization"} & {k.lower() for k in headers}
        assert headers["X-LXE-Client"] == "cli"
        if path.endswith("stock-skus/search"):
            assert body["maxRows"] == 1000 and body["way"] == 2
        else:
            assert body["rowsPerPage"] == 20 and body["showCost"] == 0
