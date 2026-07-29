"""Read-only view of the input asset slots, for the desktop workbench.

The slot layout and rotation rules live in ``shared.input_assets``; this module
only reports what is stored, so the UI never reimplements them. Keeping the
interpretation on the Python side is what stops the desktop and the CLI from
drifting apart.
"""

from __future__ import annotations

from typing import Any

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


def run(arguments: dict[str, Any]) -> dict[str, Any]:
    action = str(arguments.get("action") or "list").strip()
    if action != "list":
        return {"success": False, "exception": f"ValueError: unknown action: {action}"}
    try:
        slots = [
            {
                "slot": entry.id,
                "display_name": entry.display_name,
                "used_by": list(entry.used_by),
                "holds": entry.holds,
                "directory": str(slot_dir(entry.id)),
                "current": _generation(current_asset(entry.id)),
                "previous": _generation(previous_asset(entry.id)),
            }
            for entry in load_input_assets().values()
        ]
    except Exception as exc:  # noqa: BLE001 - public modules return failure envelopes
        return {"success": False, "exception": f"{type(exc).__name__}: {exc}"}
    return {"success": True, "slots": slots}


__all__ = ["run"]
