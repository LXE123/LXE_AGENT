"""Input asset slot contracts.

A slot keeps exactly two generations so a bad upload can be undone by hand.
Only ``current`` is ever handed to a command, and the model never sees
``previous`` — version selection must not become something it reasons about.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from openpyxl import Workbook

from shared import input_assets
from services.assets.inspect import run as inspect_assets
from services.vietnam_replenishment.sku_map_store import install_sku_map, inspect_sku_map
from shared.input_assets import (
    InputAssetError,
    current_asset,
    load_input_assets,
    promote_asset,
    slot_dir,
)
from shared.repository import repository_root

REPO_ROOT = repository_root()
CATALOG = json.loads(
    (REPO_ROOT / "python" / "lxeskill_cli" / "lxeskill" / "catalog.json").read_text(encoding="utf-8")
)
ASSETS = load_input_assets()


@pytest.fixture()
def slot_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = tmp_path / "inputs"
    monkeypatch.setattr(input_assets, "input_root", lambda: root)
    return root


def _write(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def test_promotion_keeps_current_and_previous_with_original_names(
    slot_root: Path, tmp_path: Path
) -> None:
    first = _write(tmp_path / "up1" / "采购合同模板汇总-最新.xlsx", "v1")
    second = _write(tmp_path / "up2" / "20260703-合同模板汇总.xlsx", "v2")

    promote_asset("contract_template", first)
    promote_asset("contract_template", second)

    current = current_asset("contract_template")
    assert current is not None
    assert current.file_name == "20260703-合同模板汇总.xlsx"
    assert current.path.read_text(encoding="utf-8") == "v2"

    previous = list((slot_dir("contract_template") / "previous").iterdir())
    assert [item.name for item in previous] == ["采购合同模板汇总-最新.xlsx"]
    assert previous[0].read_text(encoding="utf-8") == "v1"


def test_only_two_generations_are_kept(slot_root: Path, tmp_path: Path) -> None:
    for index in range(4):
        promote_asset("customs_template", _write(tmp_path / f"u{index}" / f"t{index}.xlsx", f"v{index}"))

    assert current_asset("customs_template").path.read_text(encoding="utf-8") == "v3"
    previous = list((slot_dir("customs_template") / "previous").iterdir())
    assert [item.read_text(encoding="utf-8") for item in previous] == ["v2"]


def test_identical_content_does_not_burn_the_rollback_slot(
    slot_root: Path, tmp_path: Path
) -> None:
    promote_asset("invoice_template", _write(tmp_path / "a" / "old.xlsx", "keep-me"))
    promote_asset("invoice_template", _write(tmp_path / "b" / "new.xlsx", "changed"))
    # Re-sending the same bytes (a retry, or the same file twice) must not push
    # the genuine previous version out.
    promote_asset("invoice_template", _write(tmp_path / "c" / "new-again.xlsx", "changed"))

    previous = list((slot_dir("invoice_template") / "previous").iterdir())
    assert [item.read_text(encoding="utf-8") for item in previous] == ["keep-me"]
    assert current_asset("invoice_template").file_name == "new.xlsx"


def test_promotion_overwrites_an_existing_previous_generation(
    slot_root: Path, tmp_path: Path
) -> None:
    """Guards the Windows path: rename onto an existing target must not raise."""
    for index in range(3):
        promote_asset("export_tax_master", _write(tmp_path / f"m{index}" / f"m{index}.xlsx", f"v{index}"))
    assert len(list((slot_dir("export_tax_master") / "previous").iterdir())) == 1


def test_empty_slot_reports_no_current_version(slot_root: Path) -> None:
    assert current_asset("export_tax_products") is None


def test_registered_slots_describe_business_name_and_usage() -> None:
    master = ASSETS["export_tax_master"]
    assert master.display_name == "出口退税总表"
    assert master.used_by == ("采购汇总", "备货工作簿")
    assert master.management == "command"
    assert all(asset.display_name and asset.used_by for asset in ASSETS.values())


def test_vietnam_slots_are_desktop_managed_and_readable(slot_root: Path) -> None:
    slots = ("vietnam_replenishment_template", "vietnam_sku_parameter_map")
    directories = {ASSETS[slot].dir for slot in slots}
    assert len(directories) == len(slots)
    assert all(directory.startswith("vietnam/") for directory in directories)
    assert all(ASSETS[slot].management == "desktop" for slot in slots)
    assert all(current_asset(slot) is None for slot in slots)

    inspected = inspect_assets({})
    assert inspected["success"] is True
    reported = {item["slot"]: item for item in inspected["slots"]}
    assert all(reported[slot]["management"] == "desktop" for slot in slots)


@pytest.mark.parametrize("slot", ["vietnam_replenishment_template", "vietnam_sku_parameter_map"])
def test_generic_promotion_rejects_desktop_slots_before_file_access(
    slot_root: Path, tmp_path: Path, slot: str
) -> None:
    with pytest.raises(InputAssetError, match="desktop-managed"):
        promote_asset(slot, tmp_path / "not-read.xlsx")
    assert current_asset(slot) is None
    assert not slot_root.exists()


def test_unknown_slot_and_missing_file_fail_loudly(slot_root: Path, tmp_path: Path) -> None:
    with pytest.raises(InputAssetError):
        current_asset("not_a_slot")
    with pytest.raises(InputAssetError):
        promote_asset("customs_template", tmp_path / "absent.xlsx")


def test_every_declared_slot_binding_is_registered_and_optional() -> None:
    """A slot-backed field must resolve, and must not also be schema-required."""
    for entry in CATALOG["entries"]:
        schema = entry.get("input_schema") or {}
        required = set(schema.get("required") or [])
        for field, definition in (schema.get("properties") or {}).items():
            slot = str((definition or {}).get("x-lxe-asset-slot") or "")
            if not slot:
                continue
            assert slot in ASSETS, f"{entry['name']}.{field} -> unknown slot {slot}"
            assert ASSETS[slot].management == "command", (
                f"{entry['name']}.{field} binds desktop-managed slot {slot}"
            )
            assert field not in required, (
                f"{entry['name']}.{field} is slot-backed but still required; "
                "omitting it must fall back to the stored version"
            )
            assert "x-lxe-file-input" in (definition or {}), (
                f"{entry['name']}.{field} is slot-backed but has no x-lxe-file-input, "
                "so a cold slot cannot tell the model what to ask for"
            )


def test_every_registered_slot_is_bound_to_at_least_one_field() -> None:
    bound = {
        str((definition or {}).get("x-lxe-asset-slot") or "")
        for entry in CATALOG["entries"]
        for definition in ((entry.get("input_schema") or {}).get("properties") or {}).values()
    }
    command_slots = {slot for slot, entry in ASSETS.items() if entry.management == "command"}
    desktop_slots = {slot for slot, entry in ASSETS.items() if entry.management == "desktop"}
    assert not command_slots - bound, f"registered but unused command slots: {sorted(command_slots - bound)}"
    assert not desktop_slots & bound, f"desktop-managed slots bound to commands: {sorted(desktop_slots & bound)}"


def test_input_slots_never_collide_with_artifact_dirs() -> None:
    """Inputs live apart from output so clearing artifacts cannot delete assets."""
    from shared.datasets import load_datasets

    artifact_dirs = {entry.dir for entry in load_datasets().values()}
    slot_dirs = {entry.dir for entry in ASSETS.values()}
    assert not (artifact_dirs & slot_dirs)



def _vietnam_map(path: Path, price: int) -> Path:
    book = Workbook()
    book.active.append(("SKU", "成本", "跨境价", "折扣价", "热销标记"))
    book.active.append(("VN-A", 0, price, 15, None))
    book.save(path)
    book.close()
    return path


def test_legacy_vietnam_directory_is_not_current_or_listed(
    slot_root: Path, tmp_path: Path,
) -> None:
    legacy = slot_dir("vietnam_sku_parameter_map") / "current"
    legacy.mkdir(parents=True)
    _vietnam_map(legacy / "legacy.xlsx", 20)
    assert current_asset("vietnam_sku_parameter_map") is None
    listed = inspect_assets({})
    managed = next(row for row in listed["slots"] if row["slot"] == "vietnam_sku_parameter_map")
    assert managed["current"] is None
    assert managed["manifest_revision"] is None
    assert managed["management"] == "desktop"


def test_managed_list_reports_revision_and_recoverable_previous(
    slot_root: Path, tmp_path: Path,
) -> None:
    first = install_sku_map(_vietnam_map(tmp_path / "a.xlsx", 20), None)
    second = install_sku_map(_vietnam_map(tmp_path / "b.xlsx", 30), first.manifest_revision)
    stored = inspect_sku_map().current.path
    stored.write_bytes(b"damaged")
    result = inspect_assets({})
    assert result["success"] is True
    managed = next(row for row in result["slots"] if row["slot"] == "vietnam_sku_parameter_map")
    assert managed["manifest_revision"] == second.manifest_revision
    assert managed["current"] is None and managed["current_error"]
    assert managed["previous"]["file_name"] == "a.xlsx"
    with pytest.raises(InputAssetError, match="ZIP"):
        current_asset("vietnam_sku_parameter_map")
    assert current_asset("export_tax_products") is None


def test_bad_managed_manifest_does_not_hide_other_slots(slot_root: Path) -> None:
    root = slot_dir("vietnam_sku_parameter_map")
    root.mkdir(parents=True)
    (root / "manifest.json").write_text("{}", encoding="utf-8")
    result = inspect_assets({})
    assert result["success"] is True
    assert len(result["slots"]) == len(ASSETS)
    managed = next(row for row in result["slots"] if row["slot"] == "vietnam_sku_parameter_map")
    assert managed["manifest_error"] and managed["manifest_revision"] is None
    with pytest.raises(InputAssetError, match="清单"):
        current_asset("vietnam_sku_parameter_map")
