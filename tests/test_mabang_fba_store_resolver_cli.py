from __future__ import annotations

import json
from pathlib import Path

from agent_runtime.skill_index import load_skill_index
from services.agent_cli.mabang import resolve_fba_store as cli
from services.mabang.amazon.fba.store_resolver import (
    FbaStore,
    FbaStoreAmbiguousError,
    FbaStoreListResult,
    FbaStoreResolveResult,
)


def _read_payload(capsys) -> dict:
    output = capsys.readouterr().out.strip().splitlines()
    assert output
    return json.loads(output[-1])


async def _noop_close_all_network_clients() -> None:
    return None


def test_list_stores_returns_json(monkeypatch, capsys) -> None:
    monkeypatch.setattr(cli, "close_all_network_clients", _noop_close_all_network_clients)

    async def fake_list_fba_stores():
        return FbaStoreListResult(
            stores=[
                FbaStore(store_name="JP Store", store_id="101"),
                FbaStore(store_name="UK Store", store_id="102"),
            ],
            xlsx_path="artifacts/mabang_fba_store_resolver/FBA店铺列表_20260521_153000.xlsx",
        )

    monkeypatch.setattr(cli, "list_fba_stores", fake_list_fba_stores)

    exit_code = cli.main([])

    payload = _read_payload(capsys)
    assert exit_code == 0
    assert payload == {
        "success": True,
        "store_count": 2,
        "fba_warehouse_count": 2,
        "shop_count": 0,
        "xlsx_path": "artifacts/mabang_fba_store_resolver/FBA店铺列表_20260521_153000.xlsx",
        "source": "mabang_fba_store_resolver",
    }
    assert "stores" not in payload


def test_resolve_store_returns_json(monkeypatch, capsys) -> None:
    monkeypatch.setattr(cli, "close_all_network_clients", _noop_close_all_network_clients)

    async def fake_resolve_fba_store(store_name: str):
        assert store_name == "JP"
        return FbaStoreResolveResult(
            query="JP",
            match_status="contains",
            store=FbaStore(store_name="JP Store", store_id="101"),
        )

    monkeypatch.setattr(cli, "resolve_fba_store", fake_resolve_fba_store)

    exit_code = cli.main(["--store-name", "JP"])

    payload = _read_payload(capsys)
    assert exit_code == 0
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
    monkeypatch.setattr(cli, "close_all_network_clients", _noop_close_all_network_clients)

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

    exit_code = cli.main(["--store-name", "Store"])

    payload = _read_payload(capsys)
    assert exit_code == 1
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
    monkeypatch.setattr(cli, "close_all_network_clients", _noop_close_all_network_clients)
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

    exit_code = cli.main(["--store-name", "Amazon"])

    payload = _read_payload(capsys)
    assert exit_code == 1
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
    monkeypatch.setattr(cli, "close_all_network_clients", _noop_close_all_network_clients)

    async def fake_list_fba_stores():
        raise RuntimeError("fetch failed")

    monkeypatch.setattr(cli, "list_fba_stores", fake_list_fba_stores)

    exit_code = cli.main([])

    payload = _read_payload(capsys)
    assert exit_code == 1
    assert payload == {
        "success": False,
        "query": "",
        "exception": "fetch failed",
    }


def test_skill_index_loads_mabang_fba_store_resolve() -> None:
    manifest = load_skill_index(force_reload=True).get("replenishment-store-resolve")

    assert manifest is not None
    assert manifest.name == "replenishment-store-resolve"
    assert manifest.type == "amazon_replenish"
