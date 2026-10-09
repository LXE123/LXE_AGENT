"""Read-only view of the input asset slots, for the desktop workbench.

The slot layout and rotation rules live in ``shared.input_assets``; this module
only reports what is stored, so the UI never reimplements them. Keeping the
interpretation on the Python side is what stops the desktop and the CLI from
drifting apart.
"""

from __future__ import annotations

from typing import Any

from services.vietnam_replenishment.sku_map_store import SKU_SLOT, inspect_sku_map
from shared.input_assets import (
    AssetVersion,
    current_asset,
    load_input_assets,
    previous_asset,
    slot_dir,
)


def _generation(version: AssetVersion | None) -> dict[str, Any] | None:
    if version is None:
        return None
    return {
        "file_name": version.file_name,
        "path": str(version.path),
        "size_bytes": version.path.stat().st_size,
        "updated_at": version.updated_at,
    }


def _managed_generation(version) -> dict[str, Any] | None:
    if version is None:
        return None
    return {
        "file_name": version.file_name,
        "path": str(version.path),
        "size_bytes": version.size_bytes,
        "updated_at": version.updated_at,
    }


def _slot(entry) -> dict[str, Any]:
    common = {
        "slot": entry.id,
        "display_name": entry.display_name,
        "management": entry.management,
        "used_by": list(entry.used_by),
        "holds": entry.holds,
        "directory": str(slot_dir(entry.id)),
    }
    if entry.id == SKU_SLOT:
        status = inspect_sku_map()
        return {
            **common,
            "manifest_revision": status.revision,
            "current": _managed_generation(status.current),
            "previous": _managed_generation(status.previous),
            "current_error": status.current_error,
            "previous_error": status.previous_error,
            "manifest_error": status.manifest_error,
        }
    return {
        **common,
        "manifest_revision": None,
        "current": _generation(current_asset(entry.id)),
        "previous": _generation(previous_asset(entry.id)),
    }


def run(arguments: dict[str, Any]) -> dict[str, Any]:
    action = str(arguments.get("action") or "list").strip()
    if action != "list":
        return {"success": False, "exception": f"ValueError: unknown action: {action}"}
    try:
        slots = [_slot(entry) for entry in load_input_assets().values()]
    except Exception as exc:  # noqa: BLE001 - public modules return failure envelopes
        return {"success": False, "exception": f"{type(exc).__name__}: {exc}"}
    return {"success": True, "slots": slots}


__all__ = ["run"]
