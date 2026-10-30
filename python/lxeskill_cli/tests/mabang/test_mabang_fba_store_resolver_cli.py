from __future__ import annotations

from pathlib import Path

from openpyxl import load_workbook

from services.commands.mabang import resolve_fba_store as cli
from services.mabang.amazon.fba import store_resolver as stores
from services.mabang.amazon.fba.store_resolver import (
    FbaStore,
    FbaStoreAmbiguousError,
    FbaStoreListResult,
    FbaStoreResolveResult,
)


def test_list_stores_returns_json(monkeypatch, capsys) -> None:

    async def fake_list_fba_stores():
        return FbaStoreListResult(
            stores=[
                FbaStore(store_name="JP Store", store_id="101"),
                FbaStore(store_name="UK Store", store_id="102"),
            ],
            xlsx_path="artifacts/mabang_fba_store_resolver/FBA店铺列表_20260521_153000.xlsx",
        )

    monkeypatch.setattr(cli, "list_fba_stores", fake_list_fba_stores)

    payload = cli.run({})
    assert payload == {
        "success": True,
        "store_count": 2,
        "fba_warehouse_count": 2,
        "shop_count": 0,
        "xlsx_path": "artifacts/mabang_fba_store_resolver/FBA店铺列表_20260521_153000.xlsx",
        "source": "mabang_fba_store_resolver",
    }
    assert "stores" not in payload


def test_no_name_lists_real_candidate_identities_once(monkeypatch, tmp_path) -> None:
    candidates = [
        FbaStore(store_name="Amazon-示例组", store_id="100"),
        FbaStore(store_name="Amazon-示例-US", store_id="101", id_type="shopId", parent_store_name="Amazon-示例组"),
        FbaStore(store_name="Amazon-示例-UK", store_id="102", id_type="shopId", parent_store_name="Amazon-示例组"),
    ]
    calls = []

    async def fetch():
        calls.append("fetch")
        return candidates

    monkeypatch.setattr(stores, "fetch_fba_stores", fetch)
    monkeypatch.setattr(stores, "_resolve_output_dir", lambda _output_dir: tmp_path)
    payload = cli.run({})
    assert payload["success"] is True and payload["store_count"] == 3
    book = load_workbook(payload["xlsx_path"], read_only=True)
    try:
        rows = list(book[stores.STORE_LIST_SHEET].values)
        assert rows[0] == stores.STORE_XLSX_HEADERS
        assert rows[1:] == [
            ("Amazon-示例组", "100", "fbaWarehouseIds[]", None),
            ("Amazon-示例-US", "101", "shopId", "Amazon-示例组"),
            ("Amazon-示例-UK", "102", "shopId", "Amazon-示例组"),
        ]
    finally:
        book.close()
    assert calls == ["fetch"]


def test_resolve_store_returns_json(monkeypatch, capsys) -> None:

    async def fake_resolve_fba_store(store_name: str):
        assert store_name == "JP"
        return FbaStoreResolveResult(
            query="JP",
            match_status="contains",
            store=FbaStore(store_name="JP Store", store_id="101"),
        )

    monkeypatch.setattr(cli, "resolve_fba_store", fake_resolve_fba_store)

    payload = cli.run({"store_name": "JP"})
    assert payload == {
        "success": True,
        "query": "JP",
        "match_status": "contains",
        "store_name": "JP Store",
        "store_id": "101",
        "id_type": "fbaWarehouseIds[]",
        "parent_store_name": "",
        "source": "mabang_fba_store_resolver",
    }


def test_ambiguous_error_returns_candidates(monkeypatch, capsys) -> None:

    async def fake_resolve_fba_store(store_name: str):
        raise FbaStoreAmbiguousError(
            "店铺名不唯一: query=Store, count=2",
            query=store_name,
            candidates=[
                {
                    "store_name": "JP Store",
                    "store_id": "101",
                    "id_type": "fbaWarehouseIds[]",
                    "parent_store_name": "",
                },
                {
                    "store_name": "UK Store",
                    "store_id": "102",
                    "id_type": "fbaWarehouseIds[]",
                    "parent_store_name": "",
                },
            ],
        )

    monkeypatch.setattr(cli, "resolve_fba_store", fake_resolve_fba_store)

    payload = cli.run({"store_name": "Store"})
    assert payload == {
        "success": False,
        "query": "Store",
        "exception": "店铺名不唯一: query=Store, count=2",
        "candidates": [
            {
                "store_name": "JP Store",
                "store_id": "101",
                "id_type": "fbaWarehouseIds[]",
                "parent_store_name": "",
            },
            {
                "store_name": "UK Store",
                "store_id": "102",
                "id_type": "fbaWarehouseIds[]",
                "parent_store_name": "",
            },
        ],
    }


def test_large_ambiguous_error_returns_candidates_xlsx(monkeypatch, tmp_path, capsys) -> None:
    captured_stores: list[FbaStore] = []

    def fake_write_fba_stores_xlsx(stores, *, filename_prefix="", **kwargs):
        captured_stores.extend(stores)
        assert filename_prefix == "FBA店铺候选_Amazon"
        path = tmp_path / "candidates.xlsx"
        path.write_bytes(b"xlsx")
        return path

    async def fake_resolve_fba_store(store_name: str):
        raise FbaStoreAmbiguousError(
            "店铺名不唯一: query=Amazon, count=11",
            query=store_name,
            candidates=[
                {
                    "store_name": f"Amazon-{index:02d}",
                    "store_id": str(1000 + index),
                    "id_type": "fbaWarehouseIds[]",
                    "parent_store_name": "",
                }
                for index in range(11)
            ],
        )

    monkeypatch.setattr(cli, "write_fba_stores_xlsx", fake_write_fba_stores_xlsx)
    monkeypatch.setattr(cli, "resolve_fba_store", fake_resolve_fba_store)

    payload = cli.run({"store_name": "Amazon"})
    assert payload == {
        "success": False,
        "query": "Amazon",
        "exception": "店铺名不唯一: query=Amazon, count=11",
        "candidate_count": 11,
        "candidates_xlsx_path": str(tmp_path / "candidates.xlsx"),
    }
    assert "candidates" not in payload
    assert len(captured_stores) == 11
    assert all(isinstance(store, FbaStore) for store in captured_stores)
    assert Path(payload["candidates_xlsx_path"]).is_file()


def test_generic_error_returns_failure_json(monkeypatch, capsys) -> None:

    async def fake_list_fba_stores():
        raise RuntimeError("fetch failed")

    monkeypatch.setattr(cli, "list_fba_stores", fake_list_fba_stores)

    payload = cli.run({})
    assert payload == {
        "success": False,
        "query": "",
        "exception": "fetch failed",
    }
