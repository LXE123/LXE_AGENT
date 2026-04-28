from __future__ import annotations

from typing import Any, Callable

from services.browser.workflows.amazon_fba_confirm_own_carrier import (
    run_confirm_own_carrier_workflow,
)
from services.browser.workflows.amazon_fba_enter_tracking_codes import (
    run_enter_tracking_codes_workflow,
)
from services.browser.workflows.amazon_fba_prepare_multi_box_excel import (
    run_prepare_multi_box_excel_workflow,
)
from services.browser.workflows.amazon_fba_prepare_upload import run_prepare_upload_workflow


FixedFlowRunner = Callable[..., dict[str, Any]]


_BROWSER_FLOW_RUNNERS: dict[str, FixedFlowRunner] = {
    "amazon_fba.confirm_own_carrier": run_confirm_own_carrier_workflow,
    "amazon_fba.enter_tracking_codes": run_enter_tracking_codes_workflow,
    "amazon_fba.prepare_multi_box_excel": run_prepare_multi_box_excel_workflow,
    "amazon_fba.prepare_upload": run_prepare_upload_workflow,
}


def execute_browser_workflow(
    *,
    runtime: Any,
    workflow: str,
    payload: dict[str, Any] | None,
    event_writer: Callable[[dict[str, Any]], None],
) -> dict[str, Any]:
    workflow_name = str(workflow or "").strip()
    runner = _BROWSER_FLOW_RUNNERS.get(workflow_name)
    if runner is None:
        raise ValueError(f"unknown workflow: {workflow_name}")
    return runner(
        runtime=runtime,
        payload=dict(payload or {}),
        event_writer=event_writer,
    )


__all__ = ["execute_browser_workflow"]
