from __future__ import annotations

from typing import Any, Callable

from services.agent_cli._shared.context_json import context_payload, merge_context_payloads
from services.agent_cli._shared.json_output import configure_utf8_stdio, write_result_event
from services.agent_cli.browser.amazon_fba._shared import (
    archive_selected_result_files,
    build_parser,
    exception_text,
    finalize_fba_cli_process,
    not_ready_result,
    run_direct_fba_workflow,
    validate_args,
)
from services.browser.workflows.amazon_fba_prepare_upload import run_prepare_upload_workflow
from shared.logging import setup_logging


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
