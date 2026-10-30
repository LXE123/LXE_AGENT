"""Internal lxeskill command for desktop Amazon V2 seasonal settings."""
from __future__ import annotations

from typing import Any

from services.commands._shared.json_cli import exception_text
from services.mabang.amazon.fba import replenishment_v2_settings as settings


def run(arguments: dict[str, Any]) -> dict[str, Any]:
    try:
        action = arguments.get("action")
        fields = {"read": {"action"}, "save": {"action", "parameters"}}
        if not isinstance(action, str) or action not in fields:
            raise ValueError(f"无效的桌面设置操作: {action!r}")
        if set(arguments) != fields[action]:
            raise ValueError(f"{action} 必须包含且仅包含: {', '.join(sorted(fields[action]))}")
        data = settings.read_state() if action == "read" else settings.save_parameters(arguments["parameters"])
        return {"success": True, "data": data}
    except Exception as exc:  # noqa: BLE001 — the existing CLI turns actual failures into standard terminals.
        return {"success": False, "exception": f"{type(exc).__name__}: {exception_text(exc)}"}
