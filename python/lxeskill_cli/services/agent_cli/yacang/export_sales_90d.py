from __future__ import annotations

from typing import Any

from services.agent_cli.yacang._shared import reject_unknown_arguments
from services.yacang.exports.sales_90d import export_sales_90d
from services.yacang.reporting import cli_failure


def run(arguments: dict[str, Any]) -> dict[str, Any]:
    """lxeskill entrypoint — credentials and low-level API parameters stay internal."""
    try:
        reject_unknown_arguments(arguments, {"as_of_date"})
        return export_sales_90d(as_of_date=arguments.get("as_of_date"))
    except Exception as exc:  # noqa: BLE001 - real sanitized failure is the command result
        return cli_failure(
            exc,
            business_type="sales-90d",
            context={"as_of_date": str(arguments.get("as_of_date") or "")},
        )


__all__ = ["run"]
