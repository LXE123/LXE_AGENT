from __future__ import annotations

from typing import Any, Callable

from services.agent_cli.browser.amazon_fba._shared import run_direct_fba_workflow, run_stage
from services.browser.workflows.amazon_fba_confirm_own_carrier import run_confirm_own_carrier_workflow


def run_confirm_own_carrier(
    *,
    context: dict[str, str],
    timeout_sec: int = 180,
    workflow_runner: Callable[..., dict[str, Any]] = run_confirm_own_carrier_workflow,
) -> dict[str, Any]:
    return run_direct_fba_workflow(
        context=context,
        timeout_sec=timeout_sec,
        workflow_runner=workflow_runner,
        include_file_path=True,
    )


def run(arguments: dict[str, Any]) -> dict[str, Any]:
    """lxeskill entrypoint — the catalog input_schema is the argument contract."""
    return run_stage(
        arguments,
        run_confirm_own_carrier,
        archive_keys=("shipment_summary_excel",),
        stage='confirm_own_carrier',
    )
