"""Artifact dataset registry — the single source of truth for artifact locations.

The registry lives in ``lxeskill/catalog.json`` under the top-level ``datasets``
key so that the Bun runtime reads the same contract when it builds the system
prompt. Business modules must resolve output directories through
:func:`dataset_dir` instead of hardcoding directory names.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
import re
from typing import Any, NamedTuple

from shared.workspace import artifact_root


_ID_PATTERN = re.compile(r"^[a-z][a-z0-9_]*$")
_SEGMENT_PATTERN = re.compile(r"^[a-z][a-z0-9_]*$")


class DatasetRegistryError(RuntimeError):
    pass


class Dataset(NamedTuple):
    id: str
    dir: str
    holds: str
    legacy_dirs: tuple[str, ...]

    @property
    def module(self) -> str:
        return self.dir.split("/", 1)[0]


def _catalog_path() -> Path:
    return Path(__file__).resolve().parent.parent / "lxeskill" / "catalog.json"


def _validate_relative_dir(value: str, *, dataset_id: str, field: str) -> str:
    segments = value.split("/")
    if not value or not all(_SEGMENT_PATTERN.fullmatch(segment) for segment in segments):
        raise DatasetRegistryError(f"invalid dataset {field} for {dataset_id}: {value}")
    return value


@lru_cache(maxsize=1)
def load_datasets() -> dict[str, Dataset]:
    document = json.loads(_catalog_path().read_text(encoding="utf-8"))
    raw = document.get("datasets")
    if not isinstance(raw, dict) or not raw:
        raise DatasetRegistryError("catalog.json has no datasets registry")
    datasets: dict[str, Dataset] = {}
    seen_dirs: dict[str, str] = {}
    seen_legacy: dict[str, str] = {}
    for dataset_id, value in raw.items():
        if not _ID_PATTERN.fullmatch(str(dataset_id)):
            raise DatasetRegistryError(f"invalid dataset id: {dataset_id}")
        item: dict[str, Any] = dict(value or {})
        directory = _validate_relative_dir(
            str(item.get("dir") or ""), dataset_id=dataset_id, field="dir"
        )
        holds = str(item.get("holds") or "").strip()
        if not holds:
            raise DatasetRegistryError(f"dataset has no holds description: {dataset_id}")
        legacy = tuple(
            _validate_relative_dir(str(entry), dataset_id=dataset_id, field="legacy_dirs")
            for entry in list(item.get("legacy_dirs") or [])
        )
        if directory in seen_dirs:
            raise DatasetRegistryError(
                f"duplicate dataset dir {directory}: {seen_dirs[directory]} and {dataset_id}"
            )
        seen_dirs[directory] = dataset_id
        for entry in legacy:
            if entry in seen_legacy:
                raise DatasetRegistryError(
                    f"duplicate legacy dir {entry}: {seen_legacy[entry]} and {dataset_id}"
                )
            seen_legacy[entry] = dataset_id
        datasets[dataset_id] = Dataset(
            id=dataset_id, dir=directory, holds=holds, legacy_dirs=legacy
        )
    collisions = set(seen_legacy) & set(seen_dirs)
    if collisions:
        raise DatasetRegistryError(f"legacy dirs collide with active dirs: {sorted(collisions)}")
    return datasets


def dataset(dataset_id: str) -> Dataset:
    try:
        return load_datasets()[dataset_id]
    except KeyError as exc:
        raise DatasetRegistryError(f"unknown dataset id: {dataset_id}") from exc


def dataset_dir(dataset_id: str, *parts: str) -> Path:
    """Resolve a registered dataset directory under the active artifact root."""
    return artifact_root().joinpath(dataset(dataset_id).dir, *parts)


__all__ = [
    "Dataset",
    "DatasetRegistryError",
    "dataset",
    "dataset_dir",
    "load_datasets",
]
