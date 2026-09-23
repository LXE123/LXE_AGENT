from __future__ import annotations

from typing import Any

from .export_products import run_action


def run(arguments: dict[str, Any]) -> dict[str, Any]:
    return run_action(arguments, action="execute")


def run_with_events(arguments: dict[str, Any], on_event: Any) -> dict[str, Any]:
    return run_action(arguments, action="execute", on_event=on_event)
