"""Catalog-only session ownership, real loopback HTTP and unchanged failure contracts."""
import asyncio

import aiohttp
from aiohttp import web

from services.mabang import official_api as http
from services.mabang.amazon.fba import sku_catalog as catalog
from shared.infra.cloud_async import AsyncCloudClient


def stock_page(keys=(), cursor=""):
    return {"code": 200, "data": {"data": [{"stockSku": k} for k in keys] or None, "nextCursor": cursor}}


def combo_page(sku):
    return {"code": 200, "data": {"data": [{"comboSku": sku, "comboProductDetail": [
        {"stockSku": "CHILD", "quantity": 2}]}], "page": 1, "rowsPerPage": 20, "total": 1}}


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
    assert all(isinstance(c._session.cookie_jar, aiohttp.DummyCookieJar) and not c._session.trust_env
               and c.timeout == 60 and c.max_response_bytes is None for c in clients)
    for path, body, headers in calls:
        assert not {"cookie", "authorization", "proxy-authorization"} & {k.lower() for k in headers}
        assert headers["X-LXE-Client"] == "cli"
        if path.endswith("stock-skus/search"):
            assert body["maxRows"] == 1000 and body["way"] == 2
        else:
            assert body["rowsPerPage"] == 20 and body["showCost"] == 0
