"""Artifact dataset registry contracts.

``catalog.json`` -> ``datasets`` is the single source of truth for where CLI
output lands. These tests keep the three consumers from drifting apart:
business modules (must resolve through ``dataset_dir``), the registry itself
(no dead entries), and the model-facing SKILL docs (no stale paths).
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

from shared.datasets import load_datasets
from shared.repository import repository_root, skills_root

REPO_ROOT = repository_root()
SERVICES_ROOT = REPO_ROOT / "python" / "lxeskill_cli" / "services"

DATASETS = load_datasets()
ACTIVE_DIRS = {entry.dir for entry in DATASETS.values()}
# Modules that own an artifact partition; anything else is an unregistered world.
ALLOWED_MODULES = {"fba", "replenish", "amazon", "browser", "shopee"}

_ARTIFACT_PATH_CALL = re.compile(r"\bartifact_path\s*\(")
_DATASET_DIR_CALL = re.compile(r'\bdataset_dir\(\s*"([a-z0-9_]+)"')


def _service_sources() -> list[Path]:
    return sorted(SERVICES_ROOT.rglob("*.py"))


def test_every_dataset_dir_is_module_partitioned() -> None:
    for entry in DATASETS.values():
        assert "/" in entry.dir, f"{entry.id} must live under a module: {entry.dir}"
        assert entry.module in ALLOWED_MODULES, f"{entry.id} has unknown module: {entry.module}"


def test_business_modules_never_hardcode_artifact_directories() -> None:
    """``artifact_path`` bypasses the registry; services must use ``dataset_dir``."""
    offenders = [
        str(path.relative_to(REPO_ROOT))
        for path in _service_sources()
        if _ARTIFACT_PATH_CALL.search(path.read_text(encoding="utf-8"))
    ]
    assert not offenders, (
        "these modules resolve artifact directories outside the registry; "
        f"use dataset_dir(<id>) instead: {offenders}"
    )


def test_every_referenced_dataset_id_is_registered() -> None:
    unknown: list[str] = []
    for path in _service_sources():
        for dataset_id in _DATASET_DIR_CALL.findall(path.read_text(encoding="utf-8")):
            if dataset_id not in DATASETS:
                unknown.append(f"{path.relative_to(REPO_ROOT)}: {dataset_id}")
    assert not unknown, f"unregistered dataset ids: {unknown}"


def test_registry_has_no_dead_entries() -> None:
    """A registered dataset must be reachable from code or documented for the model."""
    used: set[str] = set()
    for path in _service_sources():
        used.update(_DATASET_DIR_CALL.findall(path.read_text(encoding="utf-8")))
    documented: set[str] = set()
    for doc in skills_root().rglob("SKILL.md"):
        text = doc.read_text(encoding="utf-8")
        documented.update(entry.id for entry in DATASETS.values() if entry.dir in text)
    dead = sorted(set(DATASETS) - used - documented)
    assert not dead, f"registered but never used or documented: {dead}"


def test_legacy_dirs_do_not_collide_with_active_dirs() -> None:
    legacy = {name for entry in DATASETS.values() for name in entry.legacy_dirs}
    assert not (legacy & ACTIVE_DIRS), sorted(legacy & ACTIVE_DIRS)


def test_legacy_dirs_migrate_once_and_preserve_contents(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from shared import workspace

    root = tmp_path / "artifacts"
    (root / "mabang_fba_delivery").mkdir(parents=True)
    (root / "mabang_fba_delivery" / "SP1.csv").write_text("data", encoding="utf-8")
    (root / "mabang_replenishment_templates").mkdir(parents=True)
    (root / "mabang_replenishment_templates" / "templates.json").write_text("{}", encoding="utf-8")

    workspace._migrate_legacy_artifact_dirs(root)
    workspace._migrate_legacy_artifact_dirs(root)  # idempotent

    assert (root / "fba" / "delivery_csv" / "SP1.csv").read_text(encoding="utf-8") == "data"
    assert (root / "replenish" / "algorithm_templates" / "templates.json").exists()
    assert not (root / "mabang_fba_delivery").exists()


def test_migration_never_merges_when_both_directories_exist(tmp_path: Path) -> None:
    from shared import workspace

    root = tmp_path / "artifacts"
    (root / "mabang_fba_delivery").mkdir(parents=True)
    (root / "mabang_fba_delivery" / "legacy.csv").write_text("old", encoding="utf-8")
    (root / "fba" / "delivery_csv").mkdir(parents=True)
    (root / "fba" / "delivery_csv" / "current.csv").write_text("new", encoding="utf-8")

    workspace._migrate_legacy_artifact_dirs(root)

    assert (root / "mabang_fba_delivery" / "legacy.csv").exists(), "legacy data must survive"
    assert not (root / "fba" / "delivery_csv" / "legacy.csv").exists(), "must not silently merge"


@pytest.mark.parametrize("doc", sorted(skills_root().rglob("SKILL.md")), ids=lambda p: p.parent.name)
def test_skill_docs_reference_registered_artifact_dirs(doc: Path) -> None:
    """SKILL.md must not point the model at a directory the registry does not own."""
    legacy = {name for entry in DATASETS.values() for name in entry.legacy_dirs}
    stale = sorted(
        {
            match
            for match in re.findall(r"artifacts/([A-Za-z0-9_]+(?:/[A-Za-z0-9_]+)?)", doc.read_text(encoding="utf-8"))
            if match.split("/")[0] in legacy or (match in legacy)
        }
    )
    assert not stale, f"{doc.relative_to(REPO_ROOT)} still documents pre-registry paths: {stale}"
