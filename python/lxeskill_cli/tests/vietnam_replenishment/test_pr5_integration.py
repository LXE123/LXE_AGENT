"""One synthetic Desktop-map-to-CLI run through the managed Office Kit."""

from __future__ import annotations

from dataclasses import replace
from decimal import Decimal
import json
import os
from pathlib import Path

from openpyxl import Workbook, load_workbook
import pytest

from lxeskill import cli as lxeskill
from services.assets.inspect import run as inspect_assets
from services.assets.vietnam_sku_install import run as install_map
from services.assets.vietnam_sku_rollback import run as rollback_map
from services.vietnam_replenishment import workflow
from services.vietnam_replenishment.yacang_sources import VietnamSources
from shared import workspace


def _map(path: Path, *, cost: int, cross_border: int, discount: int) -> Path:
    book = Workbook()
    try:
        book.active.append(("SKU", "成本", "跨境价", "折扣价", "热销标记"))
        book.active.append(("VN-A", cost, cross_border, discount, None))
        book.save(path)
    finally:
        book.close()
    return path


def _sources() -> VietnamSources:
    """Use the same single-VN8806 source shape as the workflow's Office test."""
    sku = "VN-A"
    return VietnamSources(
        skus=(sku,),
        sales={sku: {
            "SKU": sku, "仓库": "VN8806", "7天销量": 0,
            "15天销量": 0, "30天销量": 0, "在途": 99,
        }},
        inventory={sku: {
            "SKU": sku, "仓库": "VN8806", "库存数量": 7,
            "占用数量": 2, "在途数量": 3, "可用库存": 5,
        }},
        products={sku: {
            "SKU": sku, "中文标题": "合成产品 A", "创建时间": "2026-09-23 10:00",
        }},
        missing_sales=(), missing_inventory=(), missing_products=(),
        in_transit={sku: Decimal("3")}, missing_in_transit=(),
        in_transit_mismatch=(sku,), artifacts={},
    )


def _three_sources() -> VietnamSources:
    base = _sources()
    sales = dict(base.sales)
    inventory = dict(base.inventory)
    products = dict(base.products)
    in_transit = dict(base.in_transit)
    for sku in ("VN-B", "VN-C"):
        sales[sku] = {
            **sales["VN-A"], "SKU": sku,
            "7天销量": 7, "15天销量": 15, "30天销量": 30,
        }
        inventory[sku] = {
            **inventory["VN-A"], "SKU": sku,
            "库存数量": 12, "占用数量": 2,
            "在途数量": 2, "可用库存": 10,
        }
        products[sku] = {
            **products["VN-A"], "SKU": sku,
            "中文标题": f"合成产品 {sku}", "创建时间": "2026-09-20 10:00",
        }
        in_transit[sku] = Decimal("2")
    return replace(
        base, skus=("VN-A", "VN-B", "VN-C"),
        sales=sales, inventory=inventory, products=products,
        in_transit=in_transit, in_transit_mismatch=(),
    )


def _sparse_map(path: Path) -> Path:
    book = Workbook()
    try:
        book.active.append(("SKU", "成本", "跨境价", "折扣价", "热销标记"))
        book.active.append(("VN-A", 10, 20, 15, None))
        book.active.append(("VN-B", 5, 25, None, None))
        book.save(path)
    finally:
        book.close()
    return path


def _managed_slot() -> dict:
    result = inspect_assets({})
    assert result["success"] is True
    return next(slot for slot in result["slots"] if slot["slot"] == "vietnam_sku_parameter_map")


@pytest.fixture()
def isolated_state(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    state = tmp_path / "state"
    original = {
        name: getattr(workspace, name)
        for name in ("_workspace_root", "_internal_root", "_artifact_root", "_input_root")
    }
    monkeypatch.setenv("LXE_DATA_ROOT", str(state))
    monkeypatch.setenv("LXE_WORKSPACE_ROOT", str(tmp_path / "workspace"))
    workspace.activate_project_workspace()
    yield state
    for name, value in original.items():
        setattr(workspace, name, value)


@pytest.mark.skipif(
    not (os.environ.get("LXE_OFFICE_NODE") and os.environ.get("LXE_OFFICE_CLI")),
    reason="Host Office Kit paths are not configured",
)
def test_install_list_replace_rollback_then_generate_one_final_workbook(
    tmp_path: Path, isolated_state: Path,
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.delenv("LXESKILL_SKILL_SCOPE", raising=False)
    for name, value in {
        "LXE_VIETNAM_WEIGHT_30D": "0.7",
        "LXE_VIETNAM_WEIGHT_15D": "0.6",
        "LXE_VIETNAM_WEIGHT_7D": "0.1",
        "LXE_VIETNAM_EXCHANGE_RATE": "4000",
    }.items():
        monkeypatch.setenv(name, value)
    export_calls: list[str] = []

    def fake_export() -> VietnamSources:
        export_calls.append("VN8806")
        return _sources()

    monkeypatch.setattr(workflow, "export_vietnam_sources", fake_export)
    a = _map(tmp_path / "map-a.xlsx", cost=10, cross_border=20, discount=15)
    b = _map(tmp_path / "map-b.xlsx", cost=11, cross_border=33, discount=25)

    first = install_map({"source_path": str(a), "expected_revision": ""})
    assert first["success"] is True and first["status"] == "installed"
    listed_a = _managed_slot()
    assert listed_a["management"] == "desktop"
    assert listed_a["manifest_revision"] == first["manifest_revision"]
    assert listed_a["current"]["file_name"] == "map-a.xlsx"
    assert listed_a["previous"] is None

    second = install_map({
        "source_path": str(b), "expected_revision": first["manifest_revision"],
    })
    assert second["success"] is True and second["status"] == "installed"
    listed_b = _managed_slot()
    assert listed_b["manifest_revision"] == second["manifest_revision"]
    assert listed_b["current"]["file_name"] == "map-b.xlsx"
    assert listed_b["previous"]["file_name"] == "map-a.xlsx"

    rolled = rollback_map({"expected_revision": second["manifest_revision"]})
    assert rolled["success"] is True and rolled["status"] == "rolled_back"
    listed_rolled = _managed_slot()
    assert listed_rolled["manifest_revision"] == rolled["manifest_revision"]
    assert listed_rolled["current"]["file_name"] == "map-a.xlsx"
    assert listed_rolled["previous"]["file_name"] == "map-b.xlsx"

    assert lxeskill.main(["vietnam", "stock", "recommend"]) == 0
    records = [json.loads(line) for line in capsys.readouterr().out.splitlines() if line.strip()]
    assert len(records) == 1
    result = records[0]
    assert result["type"] == "result" and result["ok"] is True
    assert result["data"]["config"] == {
        "weight_30d": "0.7", "weight_15d": "0.6",
        "weight_7d": "0.1", "exchange_rate": "4000",
    }
    assert result["data"]["config_source"] == "environment"
    assert result["data"]["sku_count"] == 1
    output = Path(result["data"]["output_xlsx"])
    assert output.is_relative_to(tmp_path / "workspace" / ".lxeagent" / "artifacts")
    assert result["files"] == [str(output)]
    assert export_calls == ["VN8806"]
    assert output.is_file() and output.stat().st_size > 0

    book = load_workbook(output, read_only=True, data_only=True)
    try:
        assert book.sheetnames == [
            "越南备货清单", "雅仓库存", "雅仓动销", "数据更改", "库存商品信息",
        ]
        main = book["越南备货清单"]
        assert main["E2"].value == "VN-A"
        assert [main[cell].value for cell in ("G2", "AE2", "AJ2")] == [10, 20, 15]
        assert [book["数据更改"].cell(2, column).value for column in range(1, 5)] == [
            0.7, 0.6, 0.1, 4000,
        ]
        assert [main.cell(2, column).value for column in range(48, 52)] == [
            0.7, 0.6, 0.1, 4000,
        ]
    finally:
        book.close()


@pytest.mark.skipif(
    not (os.environ.get("LXE_OFFICE_NODE") and os.environ.get("LXE_OFFICE_CLI")),
    reason="Host Office Kit paths are not configured",
)
def test_sparse_map_keeps_partial_and_unmapped_yacang_skus(
    tmp_path: Path, isolated_state: Path,
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.delenv("LXESKILL_SKILL_SCOPE", raising=False)
    for name, value in {
        "LXE_VIETNAM_WEIGHT_30D": "0.7",
        "LXE_VIETNAM_WEIGHT_15D": "0.6",
        "LXE_VIETNAM_WEIGHT_7D": "0.1",
        "LXE_VIETNAM_EXCHANGE_RATE": "4000",
    }.items():
        monkeypatch.setenv(name, value)
    export_calls: list[str] = []

    def fake_export() -> VietnamSources:
        export_calls.append("VN8806")
        return _three_sources()

    monkeypatch.setattr(workflow, "export_vietnam_sources", fake_export)
    installed = install_map({"source_path": str(_sparse_map(tmp_path / "sparse.xlsx")), "expected_revision": ""})
    assert installed["success"] is True

    assert lxeskill.main(["vietnam", "stock", "recommend"]) == 0
    records = [json.loads(line) for line in capsys.readouterr().out.splitlines() if line.strip()]
    assert len(records) == 1
    result = records[0]
    assert result["type"] == "result" and result["ok"] is True
    assert result["data"]["sku_count"] == 3
    output = Path(result["data"]["output_xlsx"])
    assert output.is_relative_to(tmp_path / "workspace" / ".lxeagent" / "artifacts")
    assert result["files"] == [str(output)]
    assert export_calls == ["VN8806"]
    assert output.is_file() and output.stat().st_size > 0
    assert not list(output.parent.glob(".vietnam-workbook-*"))

    book = load_workbook(output, data_only=True)
    try:
        assert book.sheetnames == [
            "越南备货清单", "雅仓库存", "雅仓动销", "数据更改", "库存商品信息",
        ]
        main = book["越南备货清单"]
        assert [main[f"E{row}"].value for row in (2, 3, 4)] == ["VN-A", "VN-B", "VN-C"]
        for name, column in (("雅仓库存", "B"), ("雅仓动销", "A"), ("库存商品信息", "B")):
            assert [book[name][f"{column}{row}"].value for row in (2, 3, 4)] == ["VN-A", "VN-B", "VN-C"]

        assert main["B3"].value == 2
        assert main["AJ3"].value is None
        assert all(main[f"{column}3"].value is not None for column in ("H", "AC", "AF", "AG", "AH", "AI"))
        assert all(main[f"{column}3"].value in (None, "") for column in ("AK", "AL", "AM"))

        assert all(main[f"{column}4"].value in (None, "") for column in (
            "B", "G", "AE", "AJ", "H", "AC", "AF", "AG", "AH", "AI", "AK", "AL", "AM",
        ))
        assert main["F4"].value == "合成产品 VN-C"
        assert main["J4"].value == 10
        assert main["K4"].value == 30
        assert main["AN4"].value == 2
        assert main["AA4"].value == "2026-09-20 10:00"
    finally:
        book.close()
