from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from services.mabang.amazon.fba import combo_sku as combo
from services.mabang.amazon.fba import sku_catalog as catalog
from services.mabang.official_api import OfficialApiError


def stock_page(skus=(), cursor=""):
    return {"code": 200, "data": {"data": [{"stockSku": s} for s in skus] if skus else None, "nextCursor": cursor}}


def combo_page(sku, *, total=1, page=1, records=None):
    if records is None:
        records = [{"comboSku": sku, "comboProductDetail": [{"stockSku": "S", "quantity": 2}]}] if total else []
    return {"code": 200, "data": {"data": records, "page": page, "total": total, "rowsPerPage": 20}}


def test_mixed_unique_queries_only_missing_skus_and_preserves_order(monkeypatch):
    calls = []
    async def post(endpoint, body, **kwargs):
        calls.append((endpoint, body.copy()))
        if endpoint == "stock-skus/search":
            assert body == {"stockSkuList": "S,C,U,s", "maxRows": 1000, "way": 2}
            return stock_page(["S"])
        assert endpoint == "combo-skus/search"
        return combo_page(body["comboSku"], total=1 if body["comboSku"] == "C" else 0)
    monkeypatch.setattr(catalog, "post_json", post)
    monkeypatch.setattr(combo, "post_json", post)
    result = asyncio.run(catalog.fetch_local_sku_definitions(["S", " C ", "S", "", "U", "s"]))
    assert [(r.local_sku, r.stock_type) for r in result] == [("S", 1), ("C", 2), ("U", None), ("s", None)]
    assert result[1].components[0].quantity == 2
    assert len(calls) == 4
    assert {b["comboSku"] for e, b in calls if e == "combo-skus/search"} == {"C", "U", "s"}


def test_batch_limit_fifty_and_empty_input(monkeypatch):
    calls = []
    async def post(endpoint, body, **kwargs):
        assert endpoint == "stock-skus/search"
        keys = body["stockSkuList"].split(",")
        calls.append(keys)
        return stock_page(keys)
    monkeypatch.setattr(catalog, "post_json", post)
    assert asyncio.run(catalog.fetch_local_sku_definitions([])) == ()
    assert calls == []
    result = asyncio.run(catalog.fetch_local_sku_definitions([f"S{i}" for i in range(123)]))
    assert len(result) == 123 and [len(c) for c in calls] == [50, 50, 23]


def test_real_cursor_and_null_terminal_fixture(monkeypatch):
    fixture = json.loads((Path(__file__).parent / "fixtures/stock_sku_cursor_contract.json").read_text())
    calls = []
    async def post(endpoint, body, **kwargs):
        index = len(calls)
        assert body.get("cursor") == fixture[index]["request_cursor"]
        calls.append(body.copy())
        return fixture[index]["response"]
    monkeypatch.setattr(catalog, "post_json", post)
    monkeypatch.setattr(catalog, "STOCK_PAGE_SIZE", 2)
    result = asyncio.run(catalog._stock_batch(["AMDDP021015L01", "A142wgt011002ZH", "DP201101L04-M", "DP211219SI18", "DX0210817S06"]))
    assert result == {"AMDDP021015L01", "DP201101L04-M", "DP211219SI18", "DX0210817S06"}
    assert len(calls) == 3
    assert all(c["stockSkuList"] == calls[0]["stockSkuList"] for c in calls)


@pytest.mark.parametrize("responses", [
    [{"code": 200, "data": {}}],
    [{"code": 200, "data": {"data": None, "nextCursor": "more"}}],
    [{"code": 200, "data": {"data": [], "nextCursor": None}}],
    [stock_page(["other"])],
    [stock_page(["S", "S"])],
    [stock_page(["S"], "same"), stock_page(["T"], "same")],
    [stock_page(["S"], "next"), stock_page(["S"])],
])
def test_bad_response_never_becomes_a_missing_sku(monkeypatch, responses):
    pending = iter(responses)
    async def post(*args, **kwargs):
        return next(pending)
    monkeypatch.setattr(catalog, "post_json", post)
    with pytest.raises(OfficialApiError):
        asyncio.run(catalog.fetch_local_sku_definitions(["S", "T"]))


def test_stock_http_failure_never_queries_combos(monkeypatch):
    async def denied(*args, **kwargs):
        raise OfficialApiError("batch page=1", "HTTP 403", {"detail": {"code": "mabang_access_denied"}})
    async def forbidden(*args, **kwargs):
        pytest.fail("HTTP error is not a miss")
    monkeypatch.setattr(catalog, "post_json", denied)
    monkeypatch.setattr(combo, "post_json", forbidden)
    with pytest.raises(OfficialApiError, match="mabang_access_denied"):
        asyncio.run(catalog.fetch_local_sku_definitions(["S"]))


def test_combo_search_still_requires_exact_match_and_valid_components(monkeypatch):
    async def stock(*args, **kwargs):
        return stock_page()
    async def similar(endpoint, body, **kwargs):
        return combo_page("C-similar")
    monkeypatch.setattr(catalog, "post_json", stock)
    monkeypatch.setattr(combo, "post_json", similar)
    assert asyncio.run(catalog.fetch_local_sku_definitions(["C"]))[0].stock_type is None
    async def invalid(endpoint, body, **kwargs):
        return combo_page("C", records=[{"comboSku": "C", "comboProductDetail": []}])
    monkeypatch.setattr(combo, "post_json", invalid)
    with pytest.raises(OfficialApiError, match="组件为空"):
        asyncio.run(catalog.fetch_local_sku_definitions(["C"]))


def test_four_workers_failure_and_timeout_cancel_remaining(monkeypatch):
    async def stock(*args, **kwargs):
        return stock_page()
    monkeypatch.setattr(catalog, "post_json", stock)
    async def scenario(fail):
        active = peak = finished = 0
        async def fetch(sku, **kwargs):
            nonlocal active, peak, finished
            active += 1
            peak = max(peak, active)
            try:
                await asyncio.sleep(.01)
                if fail and sku == "C0":
                    raise OfficialApiError("C0", "actual upstream error")
                await asyncio.Event().wait()
            finally:
                active -= 1
                finished += 1
        monkeypatch.setattr(catalog, "_fetch_combo", fetch)
        with pytest.raises(OfficialApiError if fail else TimeoutError):
            async with asyncio.timeout(.05):
                await catalog.fetch_local_sku_definitions([f"C{i}" for i in range(100)])
        assert peak == 4 and active == 0 and finished == 4
    asyncio.run(scenario(True))
    asyncio.run(scenario(False))


def test_source_snapshot_only_resolves_shop_not_listing(monkeypatch):
    calls = []
    async def shops(endpoint, body, **kwargs):
        calls.append(endpoint)
        assert endpoint == "shops/list" and body == {}
        return {"code": 200, "data": {"profile-key": {"sid": 10, "name": "shop", "amazonsite": "us"}}}
    async def stock(endpoint, body, **kwargs):
        calls.append(endpoint)
        return stock_page(["S"])
    monkeypatch.setattr(combo, "post_json", shops)
    monkeypatch.setattr(catalog, "post_json", stock)
    snapshot = asyncio.run(catalog.fetch_sku_catalog_snapshot("shop", ["S"]))
    assert snapshot.shop_id == "10" and snapshot.site == "us"
    assert calls == ["shops/list", "stock-skus/search"]


def test_combo_miss_only_after_complete_pagination(monkeypatch):
    calls = []
    async def stock(*args, **kwargs):
        return stock_page()
    async def pages(endpoint, body, **kwargs):
        sku, page = body["comboSku"], body["page"]
        calls.append((sku, page))
        if page == 1:
            return combo_page(sku, total=21, records=[
                {"comboSku": f"{sku}-similar-{i}"} for i in range(20)
            ])
        return combo_page(sku, total=21, page=2, records=[
            {"comboSku": sku if sku == "C" else "U-similar-last",
             "comboProductDetail": [{"stockSku": "S", "quantity": "0.5"}]}
        ])
    monkeypatch.setattr(catalog, "post_json", stock)
    monkeypatch.setattr(combo, "post_json", pages)
    result = asyncio.run(catalog.fetch_local_sku_definitions(["C", "U"]))
    assert [r.stock_type for r in result] == [2, None]
    assert result[0].components[0].quantity == .5
    assert set(calls) == {("C", 1), ("C", 2), ("U", 1), ("U", 2)}
