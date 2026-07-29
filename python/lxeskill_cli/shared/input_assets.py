"""Long-lived user-supplied assets (templates and reference tables).

These files outlive a single command: a customs template changes every few
weeks, the export-tax master table every few days. Before this registry every
command required the user to re-upload them, so the same asset accumulated
under ``artifacts/feishu/inbound/<message-id>/`` once per run.

Each slot keeps exactly two generations — ``current`` and ``previous``. Only
``current`` is ever handed to a command; ``previous`` exists so a bad upload can
be undone by hand, and is deliberately invisible to the model so that version
selection never becomes something it has to reason about.

Both generations are directories holding a single file, which preserves the
original filename for reporting ("采购合同模板汇总-最新.xlsx，07-06 上传").
"""

from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
import os
from functools import lru_cache
from pathlib import Path
import re
import shutil
from typing import NamedTuple

from shared.workspace import input_root


_SLOT_ID = re.compile(r"^[a-z][a-z0-9_]*$")
_SLOT_DIR = re.compile(r"^[a-z][a-z0-9_]*(?:/[a-z][a-z0-9_]*)*$")
_CURRENT = "current"
_PREVIOUS = "previous"


class InputAssetError(RuntimeError):
    pass


class InputAsset(NamedTuple):
    id: str
    display_name: str
    used_by: tuple[str, ...]
    dir: str
    holds: str


class AssetVersion(NamedTuple):
    path: Path
    file_name: str
    updated_at: str


def _catalog_path() -> Path:
    return Path(__file__).resolve().parent.parent / "lxeskill" / "catalog.json"


@lru_cache(maxsize=1)
def load_input_assets() -> dict[str, InputAsset]:
    document = json.loads(_catalog_path().read_text(encoding="utf-8"))
    raw = document.get("input_assets")
    if not isinstance(raw, dict) or not raw:
        raise InputAssetError("catalog.json has no input_assets registry")
    assets: dict[str, InputAsset] = {}
    seen_dirs: dict[str, str] = {}
    for slot_id, value in raw.items():
        if not _SLOT_ID.fullmatch(str(slot_id)):
            raise InputAssetError(f"invalid input asset id: {slot_id}")
        item = dict(value or {})
        display_name = str(item.get("display_name") or "").strip()
        raw_used_by = item.get("used_by")
        if not isinstance(raw_used_by, list):
            raise InputAssetError(f"input asset usages must be a list: {slot_id}")
        used_by = tuple(
            str(usage).strip()
            for usage in raw_used_by
            if str(usage).strip()
        )
        directory = str(item.get("dir") or "").strip()
        holds = str(item.get("holds") or "").strip()
        if not display_name:
            raise InputAssetError(f"input asset has no display name: {slot_id}")
        if not used_by:
            raise InputAssetError(f"input asset has no usage descriptions: {slot_id}")
        if not _SLOT_DIR.fullmatch(directory) or "/" not in directory:
            raise InputAssetError(f"invalid input asset dir for {slot_id}: {directory}")
        if not holds:
            raise InputAssetError(f"input asset has no holds description: {slot_id}")
        if directory in seen_dirs:
            raise InputAssetError(
                f"duplicate input asset dir {directory}: {seen_dirs[directory]} and {slot_id}"
            )
        seen_dirs[directory] = slot_id
        assets[slot_id] = InputAsset(
            id=slot_id,
            display_name=display_name,
            used_by=used_by,
            dir=directory,
            holds=holds,
        )
    return assets


def asset(slot_id: str) -> InputAsset:
    try:
        return load_input_assets()[slot_id]
    except KeyError as exc:
        raise InputAssetError(f"unknown input asset slot: {slot_id}") from exc


def slot_dir(slot_id: str) -> Path:
    return input_root() / asset(slot_id).dir


def _generation_file(slot_id: str, generation: str) -> Path | None:
    directory = slot_dir(slot_id) / generation
    if not directory.is_dir():
        return None
    files = sorted(item for item in directory.iterdir() if item.is_file())
    return files[0] if files else None


def _describe(path: Path) -> AssetVersion:
    stamp = datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc).astimezone()
    return AssetVersion(path=path, file_name=path.name, updated_at=stamp.strftime("%Y-%m-%d"))


def current_asset(slot_id: str) -> AssetVersion | None:
    """The version a command should use when the caller supplied no path."""
    path = _generation_file(slot_id, _CURRENT)
    return _describe(path) if path else None


def previous_asset(slot_id: str) -> AssetVersion | None:
    """The retained rollback copy. Never handed to a command or shown to the model."""
    path = _generation_file(slot_id, _PREVIOUS)
    return _describe(path) if path else None


def _digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def promote_asset(slot_id: str, source: str | os.PathLike[str]) -> AssetVersion:
    """Make ``source`` the slot's current version, demoting the old one.

    Re-promoting identical content is a no-op, so retrying a command or sending
    the same file twice does not burn the single rollback slot.
    """
    incoming = Path(source).expanduser()
    if not incoming.is_file():
        raise InputAssetError(f"input asset is not a file: {incoming}")

    root = slot_dir(slot_id)
    current_dir = root / _CURRENT
    previous_dir = root / _PREVIOUS
    existing = _generation_file(slot_id, _CURRENT)

    if existing is not None and _digest(existing) == _digest(incoming):
        return _describe(existing)

    if existing is not None:
        # Replace the whole previous generation; never merge two generations.
        shutil.rmtree(previous_dir, ignore_errors=True)
        previous_dir.mkdir(parents=True, exist_ok=True)
        # os.replace overwrites on Windows, where Path.rename would raise.
        os.replace(existing, previous_dir / existing.name)

    shutil.rmtree(current_dir, ignore_errors=True)
    current_dir.mkdir(parents=True, exist_ok=True)
    target = current_dir / incoming.name
    shutil.copy2(incoming, target)
    return _describe(target)


__all__ = [
    "AssetVersion",
    "InputAsset",
    "InputAssetError",
    "asset",
    "current_asset",
    "load_input_assets",
    "previous_asset",
    "promote_asset",
    "slot_dir",
]
