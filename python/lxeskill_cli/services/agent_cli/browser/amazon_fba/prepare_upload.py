from __future__ import annotations

from typing import Any

from services.agent_cli.browser.amazon_fba._shared import run_stage
from services.browser.workflows.amazon_fba_prepare_upload import run_prepare_upload_workflow


def run_prepare_upload(
    *,
    context: dict[str, str],
    timeout_sec: int = 180,
    workflow_runner: Callable[..., dict[str, Any]] = run_prepare_upload_workflow,
) -> dict[str, Any]:
    return run_direct_fba_workflow(
        context=context,
        timeout_sec=timeout_sec,
        workflow_runner=workflow_runner,
    )


def run(arguments: dict[str, Any]) -> dict[str, Any]:
    """lxeskill entrypoint — the catalog input_schema is the argument contract."""
    return run_stage(
        arguments,
        run_prepare_upload,
        archive_keys=("consignment_excel", "filled_template"),
        stage='prepare_upload',
    )
