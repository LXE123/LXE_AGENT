"""Input asset slot contracts.

A slot keeps exactly two generations so a bad upload can be undone by hand.
Only ``current`` is ever handed to a command, and the model never sees
``previous`` — version selection must not become something it reasons about.
"""
from __future__ import annotations

import ast
import json
from pathlib import Path

import pytest

from shared import input_assets
from services.assets.inspect import run as inspect_assets
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


def test_read_only_source_can_be_synced_without_changing_its_metadata(slot_root, tmp_path):
    source = _write(tmp_path / "read-only.xlsx", "template")
    source.chmod(0o444)
    before = source.stat()
    try:
        version = promote_asset("contract_template", source)
        assert version.path.read_bytes() == source.read_bytes() == b"template"
        assert version.path.stat().st_mtime_ns == before.st_mtime_ns
        assert version.path.stat().st_mode & 0o200 == 0
        assert source.stat().st_mode == before.st_mode
        assert source.stat().st_mtime_ns == before.st_mtime_ns
    finally:
        source.chmod(0o600)
        for path in slot_root.rglob("*"):
            if path.is_file():
                path.chmod(0o600)


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


def test_failed_first_promotion_never_publishes_a_partial_file(slot_root, tmp_path, monkeypatch):
    source = _write(tmp_path / "template.xlsx", "complete content")

    def partial_copy(_source, destination):
        Path(destination).write_text("partial")
        raise OSError(5, "injected copy error")

    with monkeypatch.context() as fault:
        fault.setattr(input_assets.shutil, "copyfile", partial_copy)
        with pytest.raises(OSError, match="injected copy error"):
            promote_asset("contract_template", source)
    assert current_asset("contract_template") is None
    assert not list(slot_dir("contract_template").iterdir())
    assert promote_asset("contract_template", source).path.read_text() == "complete content"


def test_failed_rollback_retains_good_copies_and_the_original_error(slot_root, tmp_path, monkeypatch):
    for index in range(2):
        promote_asset("contract_template", _write(tmp_path / f"v{index}.xlsx", f"v{index}"))
    root = slot_dir("contract_template")
    original_replace = input_assets.os.replace

    def fail_current_replace(source, destination):
        if Path(destination) == root / "current":
            raise OSError(5, "injected current publication or rollback error")
        return original_replace(source, destination)

    with monkeypatch.context() as fault:
        fault.setattr(input_assets.os, "replace", fail_current_replace)
        with pytest.raises(OSError, match="injected current publication") as raised:
            promote_asset("contract_template", _write(tmp_path / "v2.xlsx", "v2"))
    assert "retained copies" in raised.value.__notes__[0]
    assert input_assets.previous_asset("contract_template").path.read_text() == "v1"
    [staging] = list(root.glob(".promote-*"))
    assert (staging / "previous" / "v0.xlsx").read_text() == "v0"


@pytest.mark.parametrize("copy_fails", [False, True])
def test_cleanup_failure_does_not_mask_promotion_result(slot_root, tmp_path, monkeypatch, copy_fails):
    first = _write(tmp_path / "first.xlsx", "first")
    second = _write(tmp_path / "second.xlsx", "second")
    promote_asset("contract_template", first)

    def fail_cleanup(_directory):
        raise OSError(5, "injected cleanup error")

    def fail_copy(_source, _destination):
        raise OSError(5, "injected copy error")

    with monkeypatch.context() as fault:
        fault.setattr(input_assets.shutil, "rmtree", fail_cleanup)
        if copy_fails:
            fault.setattr(input_assets.shutil, "copyfile", fail_copy)
            with pytest.raises(OSError, match="injected copy error"):
                promote_asset("contract_template", second)
        else:
            promote_asset("contract_template", second)
    assert current_asset("contract_template").path.read_text() == ("first" if copy_fails else "second")


def test_registered_slots_describe_business_name_and_usage() -> None:
    master = ASSETS["export_tax_master"]
    assert master.display_name == "出口退税总表"
    assert master.used_by == ("采购汇总", "备货工作簿")
    assert master.management == "command"
    assert all(asset.display_name and asset.used_by for asset in ASSETS.values())


def test_retired_vietnam_slots_are_not_registered_or_inspected(slot_root: Path) -> None:
    retired = {"vietnam_replenishment_template", "vietnam_sku_parameter_map"}
    assert ASSETS and retired.isdisjoint(ASSETS)
    inspected = inspect_assets({})
    assert inspected["success"] is True
    assert {item["slot"] for item in inspected["slots"]} == set(ASSETS)
    for slot in retired:
        with pytest.raises(InputAssetError, match="unknown input asset slot"):
            current_asset(slot)
    assert not slot_root.exists()


def test_generic_promotion_rejects_desktop_slots_before_file_access(
    slot_root: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    slot = "desktop_fixture"
    desktop = input_assets.InputAsset(slot, "Desktop fixture", ("Test",), "test/desktop", "Test data", "desktop")
    monkeypatch.setattr(input_assets, "load_input_assets", lambda: {slot: desktop})
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


def test_every_registered_slot_has_a_binding_or_business_promotion_consumer() -> None:
    bound = {
        str((definition or {}).get("x-lxe-asset-slot") or "")
        for entry in CATALOG["entries"]
        for definition in ((entry.get("input_schema") or {}).get("properties") or {}).values()
    }
    command_slots = {slot for slot, entry in ASSETS.items() if entry.management == "command"}
    desktop_slots = {slot for slot, entry in ASSETS.items() if entry.management == "desktop"}
    # Business settings may own promotion directly without binding a mutable
    # current path to a calculation argument. Count actual imported API calls,
    # not arbitrary slot-name strings or a country-specific exception list.
    promoted = set()
    for path in (REPO_ROOT / "python/lxeskill_cli/services").rglob("*.py"):
        source = path.read_text(encoding="utf-8")
        if "shared.input_assets" not in source:
            continue
        tree = ast.parse(source)
        imports = {alias.asname or alias.name for node in ast.walk(tree)
                   if isinstance(node, ast.ImportFrom) and node.module == "shared.input_assets"
                   for alias in node.names if alias.name == "promote_asset"}
        promoted.update(node.args[0].value for node in ast.walk(tree)
                        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
                        and node.func.id in imports and node.args
                        and isinstance(node.args[0], ast.Constant) and isinstance(node.args[0].value, str))
    unused = command_slots - bound - promoted
    assert not unused, f"registered but unused command slots: {sorted(unused)}"
    assert not desktop_slots & bound, f"desktop-managed slots bound to commands: {sorted(desktop_slots & bound)}"


def test_input_slots_never_collide_with_artifact_dirs() -> None:
    """Inputs live apart from output so clearing artifacts cannot delete assets."""
    from shared.datasets import load_datasets

    artifact_dirs = {entry.dir for entry in load_datasets().values()}
    slot_dirs = {entry.dir for entry in ASSETS.values()}
    assert not (artifact_dirs & slot_dirs)
