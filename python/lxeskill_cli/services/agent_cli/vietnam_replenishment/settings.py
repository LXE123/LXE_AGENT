"""Internal lxeskill command for the desktop Vietnam settings workbench."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from services.vietnam_replenishment import settings
from services.vietnam_replenishment.validation_diagnostics import validation_diagnostic


def run(arguments: dict[str, Any]) -> dict[str, Any]:
    try:
        action = arguments.get("action")
        fields = {
            "read": {"action"},
            "save": {"action", "parameters"},
            "upload": {"action", "path"},
            "export": {"action", "path"},
        }
        if not isinstance(action, str) or action not in fields:
            raise ValueError(f"无效的桌面设置操作: {action!r}")
        if set(arguments) != fields[action]:
            raise ValueError(f"{action} 必须包含且仅包含: {', '.join(sorted(fields[action]))}")
        if action in {"upload", "export"}:
            path = arguments["path"]
            if not isinstance(path, str) or not path.strip() or not Path(path).is_absolute():
                raise ValueError("设置文件必须是绝对路径")
        if action == "read":
            result = settings.read_state()
        elif action == "save":
            result = settings.save_parameters(arguments["parameters"])
        elif action == "upload":
            result = settings.upload_template(Path(arguments["path"]))
        else:
            result = settings.export_template(Path(arguments["path"]))
        return {"success": True, "data": result}
    except Exception as exc:  # noqa: BLE001 — keep actual validation and I/O diagnostics
        return {"success": False, "error": {"code": type(exc).__name__, "message": validation_diagnostic(exc)}}
