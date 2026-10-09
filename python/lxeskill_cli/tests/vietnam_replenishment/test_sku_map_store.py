"""Synthetic transaction and integrity checks for the Desktop-managed map."""

from __future__ import annotations

from pathlib import Path
import json
from zipfile import ZipFile

from openpyxl import Workbook
import pytest

from services.vietnam_replenishment import sku_map_store as store
from shared import input_assets


@pytest.fixture()
def map_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = tmp_path / "inputs"
    monkeypatch.setattr(input_assets, "input_root", lambda: root)
    return root / "vietnam" / "sku_parameter_map"


def make_map(path: Path, price: int = 20) -> Path:
    book = Workbook()
    book.active.append(("SKU", "成本", "跨境价", "折扣价", "热销标记"))
    book.active.append(("VN-A", 0, price, 15, None))
    book.save(path)
    book.close()
    return path


def test_install_idempotence_rollback_and_aba_conflict(
    tmp_path: Path, map_root: Path,
) -> None:
    a = make_map(tmp_path / "a.xlsx", 20)
    b = make_map(tmp_path / "b.xlsx", 30)
    first = store.install_sku_map(a, None)
    assert first.status == "installed"
    assert store.inspect_sku_map().current.file_name == "a.xlsx"
    again = store.install_sku_map(a, first.manifest_revision)
    assert again == store.SkuMapMutation("unchanged", first.manifest_revision)
    second = store.install_sku_map(b, first.manifest_revision)
    assert store.inspect_sku_map().previous.file_name == "a.xlsx"
    rolled = store.rollback_sku_map(second.manifest_revision)
    assert store.inspect_sku_map().current.file_name == "a.xlsx"
    assert store.inspect_sku_map().previous.file_name == "b.xlsx"
    assert rolled.manifest_revision not in {first.manifest_revision, second.manifest_revision}
    with pytest.raises(store.SkuMapStoreError, match="已变化"):
        store.install_sku_map(b, first.manifest_revision)
    assert len(list((map_root / "versions").glob("*.xlsx"))) == 2


def test_damaged_current_can_be_rolled_back_and_not_reenabled(
    tmp_path: Path, map_root: Path,
) -> None:
    first = store.install_sku_map(make_map(tmp_path / "a.xlsx"), None)
    second = store.install_sku_map(make_map(tmp_path / "b.xlsx", 30), first.manifest_revision)
    current = store.inspect_sku_map().current
    current.path.write_bytes(b"damaged")
    status = store.inspect_sku_map()
    assert status.revision == second.manifest_revision
    assert status.current is None and status.current_error
    assert status.previous and status.previous.file_name == "a.xlsx"
    with pytest.raises(store.SkuMapStoreError, match="ZIP|SHA|读取"):
        store.trusted_version("current")
    rolled = store.rollback_sku_map(second.manifest_revision)
    healed = store.inspect_sku_map()
    assert healed.revision == rolled.manifest_revision
    assert healed.current.file_name == "a.xlsx"
    assert healed.previous is None


def test_bad_manifest_preserves_other_slot_state(
    tmp_path: Path, map_root: Path,
) -> None:
    map_root.mkdir(parents=True)
    (map_root / "manifest.json").write_text('{"revision":"../../bad"}', encoding="utf-8")
    status = store.inspect_sku_map()
    assert status.manifest_error and status.revision is None
    with pytest.raises(store.SkuMapStoreError, match="结构"):
        store.install_sku_map(make_map(tmp_path / "a.xlsx"), None)


def test_legacy_current_without_manifest_is_not_trusted(
    tmp_path: Path, map_root: Path,
) -> None:
    legacy = map_root / "current"
    legacy.mkdir(parents=True)
    make_map(legacy / "old.xlsx")
    assert store.inspect_sku_map().current is None
    assert store.trusted_version("current") is None


def test_source_change_during_copy_keeps_old_manifest(
    tmp_path: Path, map_root: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    first = store.install_sku_map(make_map(tmp_path / "a.xlsx"), None)
    source = make_map(tmp_path / "b.xlsx", 30)
    original = store._validate_file
    calls = 0

    def alter_after_source(path: Path, *, label: str):
        nonlocal calls
        result = original(path, label=label)
        calls += 1
        if calls == 1:
            make_map(source, 40)
        return result

    monkeypatch.setattr(store, "_validate_file", alter_after_source)
    with pytest.raises(store.SkuMapStoreError, match="已变化"):
        store.install_sku_map(source, first.manifest_revision)
    assert store.inspect_sku_map().revision == first.manifest_revision


def test_failed_manifest_replace_keeps_old_current(
    tmp_path: Path, map_root: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    first = store.install_sku_map(make_map(tmp_path / "a.xlsx"), None)
    original = store.os.replace

    def fail_manifest(src, dst):
        if Path(dst).name == "manifest.json":
            raise OSError("injected manifest replace failure")
        return original(src, dst)

    monkeypatch.setattr(store.os, "replace", fail_manifest)
    with pytest.raises(OSError, match="injected"):
        store.install_sku_map(make_map(tmp_path / "b.xlsx", 30), first.manifest_revision)
    status = store.inspect_sku_map()
    assert status.revision == first.manifest_revision
    assert status.current.file_name == "a.xlsx"
    assert status.previous is None
    assert len(list((map_root / "versions").glob("*.xlsx"))) == 1


def test_snapshot_remains_stable_after_replacement(tmp_path: Path, map_root: Path) -> None:
    first = store.install_sku_map(make_map(tmp_path / "a.xlsx"), None)
    with store.current_sku_map_snapshot() as snapshot:
        frozen = snapshot.read_bytes()
        store.install_sku_map(make_map(tmp_path / "b.xlsx", 30), first.manifest_revision)
        assert snapshot.read_bytes() == frozen
    assert not snapshot.exists()


def test_candidate_and_storage_boundaries(
    tmp_path: Path, map_root: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    plain = tmp_path / "plain.xlsx"
    plain.write_bytes(b"not a zip")
    with pytest.raises(store.SkuMapStoreError, match="BadZipFile"):
        store.install_sku_map(plain, None)
    txt = tmp_path / "map.txt"
    txt.write_bytes(b"x")
    with pytest.raises(store.SkuMapStoreError, match=".xlsx"):
        store.install_sku_map(txt, None)
    link = tmp_path / "link.xlsx"
    link.symlink_to(make_map(tmp_path / "a.xlsx"))
    with pytest.raises(store.SkuMapStoreError, match="普通文件"):
        store.install_sku_map(link, None)
    with monkeypatch.context() as bound:
        bound.setattr(store, "MAX_MEMBERS", 1)
        archive = tmp_path / "members.xlsx"
        with ZipFile(archive, "w") as zf:
            zf.writestr("one", "x")
            zf.writestr("two", "x")
        with pytest.raises(store.SkuMapStoreError, match="条目"):
            store.install_sku_map(archive, None)


def test_linked_manifest_or_version_is_rejected(
    tmp_path: Path, map_root: Path,
) -> None:
    first = store.install_sku_map(make_map(tmp_path / "a.xlsx"), None)
    manifest = map_root / "manifest.json"
    copy = tmp_path / "manifest-copy.json"
    copy.write_bytes(manifest.read_bytes())
    manifest.unlink()
    manifest.symlink_to(copy)
    assert store.inspect_sku_map().manifest_error
    manifest.unlink()
    manifest.write_bytes(copy.read_bytes())
    version = store.inspect_sku_map().current.path
    version_copy = tmp_path / "version-copy.xlsx"
    version_copy.write_bytes(version.read_bytes())
    version.unlink()
    version.symlink_to(version_copy)
    status = store.inspect_sku_map()
    assert status.revision == first.manifest_revision
    assert status.current_error and status.current is None



def test_replacement_after_damaged_current_preserves_only_verified_previous(
    tmp_path: Path, map_root: Path,
) -> None:
    first = store.install_sku_map(make_map(tmp_path / "a.xlsx", 20), None)
    second = store.install_sku_map(make_map(tmp_path / "b.xlsx", 30), first.manifest_revision)
    store.inspect_sku_map().current.path.write_bytes(b"damaged")
    third = store.install_sku_map(make_map(tmp_path / "c.xlsx", 40), second.manifest_revision)
    status = store.inspect_sku_map()
    assert status.revision == third.manifest_revision
    assert status.current.file_name == "c.xlsx"
    assert status.previous.file_name == "a.xlsx"
    assert len(list((map_root / "versions").glob("*.xlsx"))) == 2


def test_compressed_and_declared_uncompressed_bounds(
    tmp_path: Path, map_root: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = make_map(tmp_path / "a.xlsx")
    with monkeypatch.context() as bound:
        bound.setattr(store, "MAX_COMPRESSED", 32)
        with pytest.raises(store.SkuMapStoreError, match="20 MiB"):
            store.install_sku_map(source, None)
    with monkeypatch.context() as bound:
        bound.setattr(store, "MAX_UNCOMPRESSED", 1)
        with pytest.raises(store.SkuMapStoreError, match="解压大小"):
            store.install_sku_map(source, None)


def test_symlinked_versions_directory_and_unsafe_manifest_id(
    tmp_path: Path, map_root: Path,
) -> None:
    first = store.install_sku_map(make_map(tmp_path / "a.xlsx"), None)
    manifest = map_root / "manifest.json"
    raw = json.loads(manifest.read_text(encoding="utf-8"))
    raw["current"]["id"] = "../escape"
    manifest.write_text(json.dumps(raw), encoding="utf-8")
    assert store.inspect_sku_map().manifest_error
    assert store.inspect_sku_map().revision is None
    raw["current"]["id"] = next((map_root / "versions").glob("*.xlsx")).stem
    manifest.write_text(json.dumps(raw), encoding="utf-8")
    versions = map_root / "versions"
    moved = tmp_path / "moved-versions"
    versions.rename(moved)
    versions.symlink_to(moved, target_is_directory=True)
    status = store.inspect_sku_map()
    assert status.revision == first.manifest_revision
    assert status.current is None and status.current_error



def test_next_management_cleans_unreferenced_version_and_stage(
    tmp_path: Path, map_root: Path,
) -> None:
    first = store.install_sku_map(make_map(tmp_path / "a.xlsx"), None)
    versions = map_root / "versions"
    orphan = versions / ("f" * 32 + ".xlsx")
    orphan.write_bytes(b"orphan")
    staged = versions / ("." + "e" * 32 + ".stage.xlsx")
    staged.write_bytes(b"staged orphan")
    result = store.install_sku_map(make_map(tmp_path / "same.xlsx"), first.manifest_revision)
    assert result.status == "unchanged"
    assert not orphan.exists() and not staged.exists()
    assert store.inspect_sku_map().current.file_name == "a.xlsx"


@pytest.mark.parametrize("operation", ["install", "rollback"])
def test_manifest_temp_cleanup_failure_after_commit_keeps_current_readable(
    operation: str, tmp_path: Path, map_root: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    first = store.install_sku_map(make_map(tmp_path / "a.xlsx", 20), None)
    if operation == "rollback":
        second = store.install_sku_map(
            make_map(tmp_path / "b.xlsx", 30), first.manifest_revision
        )
        expected_revision = second.manifest_revision
        expected_name = "a.xlsx"
    else:
        expected_revision = first.manifest_revision
        expected_name = "b.xlsx"

    original_unlink = Path.unlink

    def fail_manifest_temp(self: Path, *args, **kwargs) -> None:
        if self.name.startswith(".manifest.") and self.name.endswith(".tmp"):
            raise RuntimeError("injected manifest temp cleanup failure")
        original_unlink(self, *args, **kwargs)

    monkeypatch.setattr(Path, "unlink", fail_manifest_temp)
    if operation == "rollback":
        mutation = store.rollback_sku_map(expected_revision)
        assert mutation.status == "rolled_back"
    else:
        mutation = store.install_sku_map(
            make_map(tmp_path / "b.xlsx", 30), expected_revision
        )
        assert mutation.status == "installed"

    status = store.inspect_sku_map()
    assert status.revision == mutation.manifest_revision
    assert status.current is not None
    assert status.current.file_name == expected_name
    assert store.trusted_version("current").path.read_bytes() == status.current.path.read_bytes()


def test_stage_cleanup_failure_after_commit_keeps_new_version_readable(
    tmp_path: Path, map_root: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    first = store.install_sku_map(make_map(tmp_path / "a.xlsx", 20), None)
    original_unlink = Path.unlink

    def fail_stage_temp(self: Path, *args, **kwargs) -> None:
        if self.name.startswith(".") and self.name.endswith(".stage.xlsx"):
            raise RuntimeError("injected stage temp cleanup failure")
        original_unlink(self, *args, **kwargs)

    monkeypatch.setattr(Path, "unlink", fail_stage_temp)
    mutation = store.install_sku_map(
        make_map(tmp_path / "b.xlsx", 30), first.manifest_revision
    )
    assert mutation.status == "installed"
    assert store.inspect_sku_map().revision == mutation.manifest_revision
    assert store.trusted_version("current").file_name == "b.xlsx"


@pytest.mark.parametrize("operation", ["install", "rollback"])
def test_postcommit_orphan_cleanup_error_does_not_change_success(
    operation: str, tmp_path: Path, map_root: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    first = store.install_sku_map(make_map(tmp_path / "a.xlsx", 20), None)
    if operation == "rollback":
        second = store.install_sku_map(
            make_map(tmp_path / "b.xlsx", 30), first.manifest_revision
        )
        expected_revision = second.manifest_revision
        expected_name = "a.xlsx"
    else:
        expected_revision = first.manifest_revision
        expected_name = "b.xlsx"

    original_cleanup = store._cleanup_orphans

    def fail_postcommit(root: Path, manifest) -> None:
        if manifest is not None and manifest.revision != expected_revision:
            raise store.SkuMapStoreError("injected postcommit cleanup failure")
        original_cleanup(root, manifest)

    monkeypatch.setattr(store, "_cleanup_orphans", fail_postcommit)
    if operation == "rollback":
        mutation = store.rollback_sku_map(expected_revision)
        assert mutation.status == "rolled_back"
    else:
        mutation = store.install_sku_map(
            make_map(tmp_path / "b.xlsx", 30), expected_revision
        )
        assert mutation.status == "installed"

    status = store.inspect_sku_map()
    assert status.revision == mutation.manifest_revision
    assert status.current is not None
    assert status.current.file_name == expected_name
    assert store.trusted_version("current").path == status.current.path
