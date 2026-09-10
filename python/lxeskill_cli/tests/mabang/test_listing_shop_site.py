from __future__ import annotations

import asyncio
import copy
import json
from pathlib import Path

import pytest

from mabang_test_helpers import _xlsx_bytes
from services.mabang.amazon.fba import combo_sku as combo, store_msku as msku
from services.mabang.amazon.fba.source_verification import load_verified_source
from services.mabang.amazon.fba.store_resolver import FbaStore
from services.mabang.official_api import OfficialApiError
from test_mabang_official_combo import listing_page

FIXTURE = json.loads((Path(__file__).parent / "fixtures/listing_de_shop_site.json").read_text())
STORE = "Amazon-Lerxiuer-DE"
SID = "697456820"


def record(**changes):
    return {**copy.deepcopy(FIXTURE["listing"]), **changes}


def detail(site="de", shop=SID):
    return [{"shopId": shop, "amazonsite": site}]


@pytest.mark.parametrize("changes,site,expected", [
    ({}, "de", "o5"),
    ({"amazonsite": None}, "de", "<缺失>"),
    ({"amazonsite": " "}, "de", "<缺失>"),
    ({"amazonsite": " O5 ", "shopList": detail(" DE ", int(SID))}, "de", " O5 "),
    ({"amazonsite": "DE"}, "de", None),
    ({"amazonsite": "uk", "shopList": detail(" GB ")}, "gb", None),
    ({"amazonsite": "o5", "shopList": detail("fr")}, "fr", "o5"),
    *[({"amazonsite": " US ", "shopList": value}, "us", None) for value in (None, [])],
])
def test_scope_accepts_verified_detail_or_legacy_top_site(changes, site, expected):
    assert combo._validate_listing_scope(record(**changes), SID, site, "test page=1") == expected


def test_missing_shop_list_uses_top_site():
    row = record(amazonsite="uk")
    del row["shopList"]
    assert combo._validate_listing_scope(row, SID, "gb", "test") is None
    del row["amazonsite"]
    with pytest.raises(OfficialApiError, match="站点信息不足"):
        combo._validate_listing_scope(row, SID, "gb", "test")


def test_live_de_request_returning_italian_shop_is_still_rejected():
    fixture = json.loads((Path(__file__).parent / "fixtures/listing_de_cross_shop.json").read_text())
    assert fixture["request"] == FIXTURE["request"]
    with pytest.raises(OfficialApiError, match="店铺不符") as exc:
        combo._validate_listing_scope(fixture["listing"], SID, "de", "sid=697456820 站点=de page=1")
    assert "697456822" in str(exc.value) and "Amazon-Lerxiuer-IT" in str(exc.value)


@pytest.mark.parametrize("changes,reason", [
    ({"shopIds": "other"}, "店铺不符"),
    ({"shopIds": SID + ",other"}, "店铺不符"),
    ({"shopIds": None}, "店铺不符"),
    ({"shopList": detail("fr")}, "明确站点冲突"),
    ({"amazonsite": "fr"}, "明确站点冲突"),
    ({"amazonsite": "de", "shopList": detail("fr")}, "明确站点冲突"),
    ({"amazonsite": "de", "shopList": detail(None)}, "站点信息不足"),
    ({"shopList": detail("o5")}, "站点信息不足"),
    ({"shopList": detail(shop="123")}, "店铺不符"),
    ({"shopList": detail(shop=None)}, "无效整数"),
    ({"shopList": detail(shop=True)}, "无效整数"),
    ({"shopList": detail() * 2}, "结构异常"),
    ({"shopList": detail() + detail(shop="123")}, "结构异常"),
    *[({"shopList": value}, "结构异常") for value in ({}, "", 0, False, [None])],
    *[({"amazonsite": value}, "结构异常") for value in (5, {}, [])],
    ({"shopList": []}, "站点信息不足"),
    ({"shopList": None, "amazonsite": None}, "站点信息不足"),
    ({"shopList": [], "amazonsite": "fr"}, "明确站点冲突"),
])
def test_scope_rejects_conflicts_and_missing_evidence(changes, reason):
    with pytest.raises(OfficialApiError, match=reason) as exc:
        combo._validate_listing_scope(record(**changes), SID, "de", "sid=697456820 站点=de page=2")
    assert "page=2" in str(exc.value) and "response=" in str(exc.value)


def mock_pages(monkeypatch, *, bad_last=False):
    calls = []

    async def post(endpoint, body, **kwargs):
        calls.append((endpoint, body))
        if endpoint == "shops/list":
            assert body == {}
            return {"code": 200, "data": {"profile-not-sid": {"name": STORE, "sid": int(SID), "amazonsite": "de"}}}
        page = int(body["page"])
        assert body == {**FIXTURE["request"], "page": str(page)}
        records = [record(platformSku=f"msku-{i}") for i in range(1000)] if page == 1 else [record()]
        if bad_last and page == 2:
            records[0]["shopList"] = detail("fr")
        return listing_page(records, page, 1001)

    monkeypatch.setattr(combo, "post_json", post)
    return calls


def test_real_response_full_pagination_and_aggregated_progress(monkeypatch, capsys):
    calls = mock_pages(monkeypatch)
    snapshot = asyncio.run(combo.fetch_listing_snapshot(STORE))
    assert (snapshot.shop_id, snapshot.site) == (SID, "de")
    assert len(snapshot.bindings) == 1001 and len(calls) == 3
    binding = snapshot.bindings[-1]
    assert (binding.msku, binding.asin, binding.local_sku, binding.stock_type) == ("0S-M98M-ZG2H", "B0GHMN19YQ", "", 1)
    output = capsys.readouterr()
    assert output.out == ""
    summaries = [line for line in output.err.splitlines() if "已按 shopList 核验" in line]
    assert len(summaries) == 2
    assert '"o5": 1000' in summaries[0] and '"o5": 1' in summaries[1]


def mock_download(monkeypatch, tmp_path, *, local_sku="", store_label=STORE):
    async def stores():
        return [FbaStore(STORE, SID, "shopId")]

    async def pipeline(spec):
        staging = spec.download_file.keywords["output_dir"]
        path = staging / f"202609101600-{STORE}_店铺MSKU数据.xlsx"
        path.write_bytes(_xlsx_bytes([{"店铺名称": store_label, "站点": "欧洲站", "MSKU": "0S-M98M-ZG2H", "ASIN": "B0GHMN19YQ", "本地SKU": local_sku}],
                                    columns=["店铺名称", "站点", "MSKU", "ASIN", "本地SKU"]))
        return msku.StoreMskuExcelResult(STORE, SID, "shopId", 1, str(path), False, False)

    monkeypatch.setattr(msku, "fetch_fba_stores", stores)
    monkeypatch.setattr(msku, "run_export_pipeline", pipeline)
    return tmp_path / f"202609101600-{STORE}_店铺MSKU数据.xlsx"


@pytest.mark.parametrize('store_label', [STORE, f'{STORE},Amazon-Lerxiuer-FR,Amazon-Lerxiuer-IT', None])
def test_download_preserves_web_identity_and_missing_local_sku_without_official_queries(monkeypatch, tmp_path, store_label):
    calls = mock_pages(monkeypatch)
    target = mock_download(monkeypatch, tmp_path, store_label=store_label)
    result = asyncio.run(msku.download_store_msku_excel(SID, "shopId", store_name=STORE, output_dir=tmp_path))
    assert result.xlsx_path == str(target)
    verified = load_verified_source(target, store_name=STORE)
    assert verified.metadata["store_id"] == SID and verified.metadata["id_type"] == "shopId"
    assert "site" not in verified.metadata and "shop_id" not in verified.metadata
    assert calls == []
    assert verified.records[0]["站点"] == "欧洲站"
    assert verified.records[0]["店铺名称"] == store_label
    assert verified.metadata["binding_verified_row_count"] == 0
    assert verified.metadata["unverified_rows"][0]["reason"] == "源表无本地SKU，不参与备货计算"
    assert list(tmp_path.iterdir()) == [target]


@pytest.mark.parametrize("existing", [False, True])
def test_catalog_later_page_failure_has_no_publication_or_auth_retry(monkeypatch, tmp_path, existing):
    from services.agent_cli.mabang import download_store_msku_excel as cli
    from services.mabang.amazon.fba import sku_catalog

    calls = mock_pages(monkeypatch)
    target = mock_download(monkeypatch, tmp_path, local_sku="S")
    async def stock(endpoint, body, **kwargs):
        calls.append((endpoint, body.copy()))
        assert endpoint == "stock-skus/search"
        if "cursor" not in body:
            return {"code": 200, "data": {"data": [{"stockSku": "S"}], "nextCursor": "next"}}
        return {"code": 200, "data": {"data": None, "nextCursor": "next"}}
    monkeypatch.setattr(sku_catalog, "post_json", stock)
    original = _xlsx_bytes([{"previous": "valid report"}], columns=["previous"])
    if existing:
        target.write_bytes(original)

    async def download(store_id, id_type, *, store_name):
        return await msku.download_store_msku_excel(store_id, id_type, store_name=store_name, output_dir=tmp_path)

    monkeypatch.setattr(cli, "download_store_msku_excel", download)
    result = cli.run({"store_id": SID, "id_type": "shopId", "store_name": STORE})
    assert not result["success"] and result["auth_refresh_required"] is False
    assert "page=2" in result["exception"] and "结构或分页数量异常" in result["exception"]
    assert [endpoint for endpoint, _ in calls] == ['stock-skus/search', 'stock-skus/search']
    assert list(tmp_path.iterdir()) == ([target] if existing else [])
    if existing:
        assert target.read_bytes() == original
