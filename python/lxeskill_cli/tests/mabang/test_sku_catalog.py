from __future__ import annotations

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from services.mabang.amazon.fba import combo_sku as combo
from services.mabang.amazon.fba import sku_catalog as catalog
from services.mabang.official_api import OfficialApiError
from services.mabang import official_api as http


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


@pytest.mark.parametrize("store_id,id_type", [("697618612", "shopId"), ("1039477", "fbaWarehouseIds[]")])
@pytest.mark.parametrize("local_skus", [[], ["S", "S"]])
def test_source_snapshot_uses_download_identity_without_official_shop_or_listing(monkeypatch, store_id, id_type, local_skus):
    from services.mabang.amazon.fba.store_resolver import FbaStore
    calls = []
    async def stock(endpoint, body, **kwargs):
        calls.append(endpoint)
        assert endpoint == "stock-skus/search"
        assert body == {"stockSkuList": "S", "maxRows": 1000, "way": 2}
        return stock_page(["S"])
    monkeypatch.setattr(combo, "post_json", stock)
    monkeypatch.setattr(catalog, "post_json", stock)
    store = FbaStore("Amazon-Lerxiuer-SE", store_id, id_type)
    snapshot = asyncio.run(catalog.fetch_sku_catalog_snapshot(store, local_skus))
    assert (snapshot.store_name, snapshot.store_id, snapshot.id_type) == (store.store_name, store_id, id_type)
    assert calls == (["stock-skus/search"] if local_skus else [])


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


def test_query_timing_counts_real_transport_pages_without_logging_skus(monkeypatch, caplog):
    monkeypatch.setenv("LXE_DATA_SERVER_URL", "https://private.test")
    caplog.set_level("INFO", logger=catalog.__name__)
    calls = []

    class Client:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        async def request_json(self, method, path, *, json_body):
            await asyncio.sleep(0)
            body = json_body.copy()
            calls.append((path, body))
            if path.endswith("stock-skus/search"):
                keys = body["stockSkuList"].split(",")
                if len(keys) == 50:
                    payload = stock_page(keys[25:] if body.get("cursor") else keys[:25],
                                         "" if body.get("cursor") else "next")
                else:
                    payload = stock_page([key for key in keys if key.startswith("private-stock-")])
            elif body["comboSku"] == "private-combo":
                payload = combo_page("private-combo", total=21, page=body["page"], records=(
                    [{"comboSku": f"similar-{i}"} for i in range(20)] if body["page"] == 1 else
                    [{"comboSku": "private-combo", "comboProductDetail": [{"stockSku": "private-child", "quantity": 2}]}]
                ))
            else:
                payload = combo_page(body["comboSku"], total=0)
            return SimpleNamespace(status_code=200, payload=payload, headers={})

    monkeypatch.setattr(http, "AsyncCloudClient", Client)
    inputs = [*[f"private-stock-{i}" for i in range(51)], "private-combo", "private-missing"]
    result = asyncio.run(catalog.fetch_local_sku_definitions([*inputs, " private-combo ", ""]))
    assert [r.local_sku for r in result] == inputs
    assert [r.stock_type for r in result] == [*[1] * 51, 2, None]
    summaries = {}
    for record in caplog.records:
        message = record.getMessage()
        if "[SkuCatalogTiming]" in message:
            assert "status=success" in message
            kind = message.split("query=", 1)[1].split()[0]
            summaries[kind] = json.loads(message.split("metrics=", 1)[1])
    assert set(summaries) == {"stock", "combo"}
    for kind in summaries:
        metrics = summaries[kind]
        assert metrics["batch_count"] == 2
        assert metrics["request_count"] == metrics["http_attempt_count"] == 3
        assert metrics["client_count"] == (1 if kind == "stock" else 0)
        assert metrics["retry_count"] == metrics["request_failure_count"] == metrics["http_failure_count"] == 0
        assert metrics["average_request_ms"] == pytest.approx(metrics["total_request_ms"] / 3, abs=.001)
        assert 0 <= metrics["total_http_ms"] <= metrics["total_request_ms"] + .001
        assert metrics["wall_ms"] >= 0
    assert len(calls) == 6
    assert all(secret not in caplog.text for secret in (*inputs, "private-child", "private.test", "next"))


def test_query_timing_preserves_stock_failure_and_stops_before_combos(monkeypatch, caplog):
    monkeypatch.setenv("LXE_DATA_SERVER_URL", "https://private.test")
    caplog.set_level("INFO", logger=catalog.__name__)

    class Client:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        async def request_json(self, method, path, **kwargs):
            assert path.endswith("stock-skus/search")
            return SimpleNamespace(status_code=403, payload={"detail": "actual-denied"}, headers={})

    monkeypatch.setattr(http, "AsyncCloudClient", Client)
    with pytest.raises(OfficialApiError, match="actual-denied"):
        asyncio.run(catalog.fetch_local_sku_definitions(["private-sku"]))
    message = next(r.getMessage() for r in caplog.records if "[SkuCatalogTiming]" in r.getMessage())
    assert "query=stock status=failed" in message
    metrics = json.loads(message.split("metrics=", 1)[1])
    assert metrics["request_count"] == metrics["request_failure_count"] == metrics["http_failure_count"] == 1
    assert "query=combo" not in caplog.text and "private-sku" not in caplog.text and "actual-denied" not in caplog.text
