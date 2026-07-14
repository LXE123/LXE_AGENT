from __future__ import annotations

import asyncio

import pytest
from aiohttp import web
from services.mabang.auth import MabangAuthContext
from services.mabang.export_common import (
    build_private_amz_headers,
    clean_cell,
    clean_text,
    excel_suffix_from_url,
    request_headers,
    safe_store_msku_file_part,
)
from shared.infra.net.aiohttp_client import (
    HttpSessionPurpose,
    HttpSessionRegistry,
    close_all_aiohttp_sessions,
)


class _DomainAuthError(Exception):
    pass


def _auth_context(cookies_by_domain: dict[str, list]) -> MabangAuthContext:
    return MabangAuthContext(
        scope="private_amz",
        account="",
        source="test",
        cookies_by_domain=cookies_by_domain,
        free_token="",
        wms_cookie_header="",
        raw={},
    )


def _headers(context: MabangAuthContext):
    return build_private_amz_headers(
        context,
        required_names=("PHPSESSID", "signed"),
        extra_cookies={"mabang_lite_rowsPerPage": "100"},
        private_extra_cookies={"exportv2": "2"},
        error_type=_DomainAuthError,
    )


def test_shared_export_helpers_preserve_existing_normalization() -> None:
    assert clean_cell(" NaN ") == ""
    assert clean_cell(" value ") == "value"
    assert clean_text(" value ") == "value"
    assert safe_store_msku_file_part(" Store / DE ") == "Store_DE"
    assert safe_store_msku_file_part("") == "store_msku"
    assert excel_suffix_from_url("https://files.example/export.XLSX?token=1") == ".xlsx"
    assert excel_suffix_from_url("https://files.example/export") == ".xls"
    assert request_headers("PHPSESSID=fresh", origin="https://origin", referer="https://referer") == {
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
        "Origin": "https://origin",
        "Referer": "https://referer",
        "Cookie": "PHPSESSID=fresh",
    }


def test_private_amz_headers_use_specific_cookie_and_preserve_extras() -> None:
    headers = _headers(
        _auth_context(
            {
                ".mabangerp.com": [
                    {"name": "PHPSESSID", "value": "broad", "domain": ".mabangerp.com"},
                    {"name": "signed", "value": "signed-value", "domain": ".mabangerp.com"},
                    {"name": "exportv2", "value": "old", "domain": ".mabangerp.com"},
                ],
                "private-amz.mabangerp.com": [
                    {
                        "name": "PHPSESSID",
                        "value": "specific",
                        "domain": "private-amz.mabangerp.com",
                    }
                ],
            }
        )
    )

    assert headers.private_amz_cookie_header == (
        "signed=signed-value; exportv2=old; PHPSESSID=specific; mabang_lite_rowsPerPage=100"
    )
    assert headers.private_cookie_header == "PHPSESSID=broad; signed=signed-value; exportv2=2"


def test_private_amz_headers_raise_the_domain_error_type() -> None:
    context = _auth_context(
        {".mabangerp.com": [{"name": "PHPSESSID", "value": "sid", "domain": ".mabangerp.com"}]}
    )

    with pytest.raises(_DomainAuthError, match="缺少 private-amz 关键 Cookie: signed"):
        _headers(context)


def test_private_amz_cookie_header_round_trips_through_stateless_session() -> None:
    received_cookie_headers: list[str] = []
    headers = _headers(
        _auth_context(
            {
                ".mabangerp.com": [
                    {"name": "PHPSESSID", "value": "fresh", "domain": ".mabangerp.com"},
                    {"name": "signed", "value": "signed-value", "domain": ".mabangerp.com"},
                ]
            }
        )
    )

    async def echo(request: web.Request) -> web.Response:
        received_cookie_headers.append(str(request.headers.get("Cookie") or ""))
        return web.Response(text="ok")

    async def run() -> None:
        app = web.Application()
        app.router.add_get("/echo", echo)
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, "localhost", 0)
        await site.start()
        sockets = list(getattr(site._server, "sockets", []) or [])
        assert sockets, "aiohttp test server did not expose sockets"
        port = int(sockets[0].getsockname()[1])

        try:
            session = HttpSessionRegistry.get(HttpSessionPurpose.ERP)
            async with session.get(
                f"http://localhost:{port}/echo",
                headers={"Cookie": headers.private_amz_cookie_header},
            ) as response:
                await response.text()
        finally:
            await close_all_aiohttp_sessions()
            await runner.cleanup()

    asyncio.run(run())

    assert received_cookie_headers == [headers.private_amz_cookie_header]
