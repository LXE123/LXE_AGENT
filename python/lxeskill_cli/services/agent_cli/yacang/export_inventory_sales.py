from __future__ import annotations

from typing import Any

from services.agent_cli.yacang._shared import bounded_number, reject_unknown_arguments
from services.yacang.reporting import cli_failure
from services.yacang.inventory_sales_export import export_inventory_sales


def run(arguments: dict[str, Any]) -> dict[str, Any]:
    """lxeskill entrypoint — credentials come only from the desktop environment."""
    try:
        reject_unknown_arguments(arguments, {
            "start_date", "end_date", "timeout_seconds", "poll_interval_seconds",
            "cache_max_age_seconds",
        })
        return export_inventory_sales(
            start_date=arguments.get("start_date"),
            end_date=arguments.get("end_date"),
            timeout_seconds=bounded_number(
                arguments.get("timeout_seconds"), name="timeout_seconds",
                default=180, minimum=30, maximum=600,
            ),
            poll_interval_seconds=bounded_number(
                arguments.get("poll_interval_seconds"), name="poll_interval_seconds",
                default=5, minimum=2, maximum=30,
            ),
            cache_max_age_seconds=bounded_number(
                arguments.get("cache_max_age_seconds"), name="cache_max_age_seconds",
                default=300, minimum=0, maximum=3600,
            ),
        )
    except Exception as exc:  # noqa: BLE001 - real sanitized failure is the command result
        return cli_failure(
            exc,
            business_type="inventory-sales",
            context={
                "start_date": str(arguments.get("start_date") or ""),
                "end_date": str(arguments.get("end_date") or ""),
            },
        )


__all__ = ["run"]
