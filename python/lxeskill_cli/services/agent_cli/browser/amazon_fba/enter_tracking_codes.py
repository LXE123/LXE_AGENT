from __future__ import annotations

from typing import Any, Callable

from services.agent_cli.browser.amazon_fba._shared import run_direct_fba_workflow, run_stage
from services.browser.workflows.amazon_fba_enter_tracking_codes import run_enter_tracking_codes_workflow


def run_enter_tracking_codes(
    *,
    context: dict[str, str],
    timeout_sec: int = 180,
    workflow_runner: Callable[..., dict[str, Any]] = run_enter_tracking_codes_workflow,
) -> dict[str, Any]:
    return run_direct_fba_workflow(
        context=context,
        timeout_sec=timeout_sec,
        workflow_runner=workflow_runner,
        include_file_path=False,
    )


def run(arguments: dict[str, Any]) -> dict[str, Any]:
    """lxeskill entrypoint — the catalog input_schema is the argument contract."""
    return run_stage(
        arguments,
        run_enter_tracking_codes,
        archive_keys=(),
        stage='',
    )
